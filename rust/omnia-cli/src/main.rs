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
    default_omnia_data_dir, process_tree_rss_bytes, redact_secrets, resolve_model_endpoint,
    run_acp_http_server, run_acp_stdio_server, run_super_eval, sanitize_windows_path, AgentStore,
    ApprovalMode, FileReadTracker, HarnessEventSink, HarnessStreamEvent, NativeSuperEngine,
    PermissionRule, PermissionsEngine, PluginRegistry, SuperEvalOptions, TurnCheckpointStore,
    WireApiMode, WorkspaceGraphIndex,
};
use omnia_core::PrivacyMask;
use omnia_workspace_ops::hardware::collect_host_system_snapshot;
use omnia_workspace_ops::net_diag::{
    default_upstream_targets, inspect_dns_and_benchmark, inspect_network_identity,
    inspect_proxy_tls_and_endpoints, run_speedtest_streaming, DnsBenchOptions, NetDiagOptions,
    SpeedtestConfig,
};
use serde_json::json;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

mod mcp_server;
mod super_cmds;
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
        "--mcp" | "mcp" => match run_mcp_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia --mcp error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
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
        "net" => match run_net_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia net error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "speedtest" => match run_speedtest_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia speedtest error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "research" => match run_research_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia research error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "think" => match run_think_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia think error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "rag" => match run_rag_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia rag error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "lifecycle" => match run_lifecycle_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia lifecycle error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "skills" => match run_skills_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia skills error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "learn" => match run_learn_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia learn error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "proceed" => match run_proceed_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia proceed error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "arena" => match run_arena_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia arena error: {}", redact_secrets(&format!("{e:#}")));
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
  omnia                          Launch Pure-Rust full-screen TUI (or --omp-tui for legacy Bun TUI)
  omnia --version
  omnia --profile-startup [--out <json>]
  omnia run --workspace <dir> --model <id> --base-url <url> [OPTIONS] \"<prompt>\"
  omnia --acp [--model <id>] [--base-url <url>] [--api-key <key>]
  omnia --acp-http [--host <ip>] [--port <n>] [--secret <key>]
  omnia --mcp [--workspace <dir>]
  omnia rewind --workspace <dir> --turn <n> [--session <id>] [--preview]
  omnia net [--dns] [--proxy] [--all] [--offline] [--json] [--privacy-mask]
  omnia speedtest [--quick | --standard] [--url <override>] [--json] [--privacy-mask]
  omnia research <query> [--workspace <dir>] [--scope web|academic|all] [--site <dom>] [--fetch] [--export <path>] [--json]
  omnia think <start|branch|falsify|redteam|conclude|list> [--workspace <dir>] [--json] ...
  omnia rag <query|sources|ingest|pin|export> [--workspace <dir>] [--tier local|global|both] [--json] ...
  omnia lifecycle <status|list|upsert|link|todo|dod|handoff|learn|lessons|gap-radar|super-state|verify> [--workspace <dir>] [--json]
  omnia skills <route|vault|dag|pipelines|doctor|codify> [--workspace <dir>] [--json] ...
  omnia learn <add|sync|status> [\"<lesson>\"] [--global] [--workspace <dir>] [--json]
  omnia proceed [status|on|off|recommended-only|full] [--workspace <dir>] [--json]
  omnia arena \"<prompt>\" --models <m1,m2[,m3,m4]> [--effort max] [--temperature 0.7] [--json]

RUN OPTIONS:
  --workspace, --cwd <dir>       Target workspace directory (default: current dir)
  --model <id>                   Model identifier (e.g. claude-sonnet-5-5, gemini-3.8-flash, gpt-6.2-sol)
  --base-url, --api-base <url>   Upstream OpenAI/Anthropic/Gemini base URL (env: OMNIA_BASE_URL)
  --api-key <key>                API key (env: OMNIA_API_KEY, HTMUSTC_API_KEY, OPENAI_API_KEY)
  --wire-api <mode>              auto | chat | responses | messages | gemini (default: auto)
  --effort, --reasoning-effort, --thinking <level>
                                 auto | none | minimal | low | medium | high | xhigh | max (default: max)
  --research <auto|deep|off>     Default-ON adaptive Deep Research mode (default: auto)
  --think <auto|deep|off>        Default-ON adaptive Deep Think mode (default: auto)
  --proactive-lifecycle <on|off> Proactive 12-artifact workspace lifecycle & auto-handoff (default: on)
  --output-format <fmt>          stream-json | json | text (default: text)
  --auto-approve                 Run with ApprovalMode::Yolo (default — full auto-approve)
  --approval-mode <mode>         yolo|turbo|full-access|unrestricted|auto-approve (default: yolo) | write | plan | always-ask | always-ask-cached
  --sandbox                      Strictly opt-in restricted sandbox (enables strict safety rules & untrusted workspace gate; default remains YOLO)
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
        "--effort",
        "--reasoning-effort",
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
        "--research",
        "--think",
        "--proactive-lifecycle",
        "--scope",
        "--site",
        "--limit",
        "--export",
        "--tier",
        "--query",
        "--top-k",
        "--url",
        "--file",
        "--content",
        "--title",
        "--id",
        "--kind",
        "--summary",
        "--complexity",
        "--winner",
        "--fg",
        "--bg",
        "--models",
        "--temperature",
        "--system-prompt",
        "--cause",
        "--invariant",
        "--verify",
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
    let use_omp_tui = args.iter().any(|a| a == "--omp-tui");

    if use_omp_tui {
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

    let sandbox_enabled = args.iter().any(|a| a == "--sandbox");
    let wire_api = arg_value(args, "--wire-api").map(|s| WireApiMode::parse_flag(&s));
    let thinking = resolve_effort_arg(args);
    let has_explicit_approval = args.iter().any(|a| {
        a == "--auto-approve" || a == "--approval-mode" || a.starts_with("--approval-mode=")
    });
    let approval_mode = if has_explicit_approval {
        resolve_approval_mode(args).ok()
    } else if sandbox_enabled {
        Some(ApprovalMode::Write)
    } else {
        None
    };
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
        sandbox: sandbox_enabled,
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
    let thinking_level = resolve_effort_arg(args);
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

    let (approval_mode, workspace_trusted, permission_rules, sandbox_enabled) =
        resolve_run_security_policy(args)?;

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
            "sandbox": sandbox_enabled,
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
        workspace_trusted,
        permission_rules,
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
        research_mode: omnia_agent::engine::AdaptiveMode::parse(
            arg_value(args, "--research").as_deref(),
        ),
        think_mode: omnia_agent::engine::AdaptiveMode::parse(
            arg_value(args, "--think").as_deref(),
        ),
        proactive_lifecycle: !matches!(
            arg_value(args, "--proactive-lifecycle")
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("off" | "false" | "0" | "no")
        ),
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
    let preview_only = args.iter().any(|a| a == "--preview" || a == "--dry-run");
    if preview_only {
        let preview = store.preview_rollback_to_turn(target_turn, &cwd)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "dryRun": true,
                "rewound": false,
                "sessionId": session_id,
                "preview": preview
            }))?
        );
        return Ok(());
    }
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

fn build_net_report_json(
    offline: bool,
    run_dns: bool,
    run_proxy: bool,
    timeout_ms: u64,
    privacy_mask: bool,
) -> serde_json::Value {
    let identity = inspect_network_identity(&NetDiagOptions {
        probe_public_ip: !offline,
        timeout_ms: timeout_ms.clamp(500, 6_000),
        force_refresh: true,
    });
    let dns = inspect_dns_and_benchmark(&DnsBenchOptions {
        run_benchmark: !offline && run_dns,
        public_ipv4_hint: identity.public_ipv4.clone(),
        ..DnsBenchOptions::default()
    });
    let targets = if !offline && run_proxy {
        default_upstream_targets()
    } else {
        Vec::new()
    };
    let proxy_tls = inspect_proxy_tls_and_endpoints(&targets, !offline && run_proxy);
    let host = collect_host_system_snapshot();
    let payload = json!({
        "privacyMasked": privacy_mask,
        "identity": identity,
        "dns": dns,
        "proxyTls": proxy_tls,
        "host": host,
    });
    if privacy_mask {
        PrivacyMask::mask_json(&payload)
    } else {
        payload
    }
}

fn run_net_cmd(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia net [--dns] [--proxy] [--all] [--offline] [--json] [--privacy-mask] [--timeout-ms <ms>]"
        );
        return Ok(());
    }
    let offline = args.iter().any(|a| a == "--offline");
    let all = args.iter().any(|a| a == "--all");
    let run_dns = all || args.iter().any(|a| a == "--dns");
    let run_proxy = all || args.iter().any(|a| a == "--proxy");
    let json_out = args.iter().any(|a| a == "--json");
    let privacy_mask = args.iter().any(|a| a == "--privacy-mask")
        || env::var("OMNIA_PRIVACY_MASK")
            .ok()
            .is_some_and(|v| matches!(v.trim(), "1" | "true" | "on"));
    let timeout_ms = arg_value(args, "--timeout-ms")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(2_500);

    let report = build_net_report_json(offline, run_dns, run_proxy, timeout_ms, privacy_mask);
    if json_out {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    let id = &report["identity"];
    let dns = &report["dns"];
    let host = &report["host"];
    let mut lines = Vec::new();
    lines.push(format!(
        "Omnia Network Observatory [{}] (privacy_mask={})",
        id["provenance"].as_str().unwrap_or("UNAVAILABLE"),
        privacy_mask
    ));
    lines.push(format!(
        "  Public IPv4 : {} | IPv6: {} | NAT: {} | VPN: {}",
        id["publicIpv4"].as_str().unwrap_or("unavailable"),
        id["publicIpv6"].as_str().unwrap_or("unavailable"),
        id["natClassification"].as_str().unwrap_or("unknown"),
        id["vpnActive"].as_bool().unwrap_or(false)
    ));
    if let Some(geo) = id.get("geo").filter(|g| !g.is_null()) {
        lines.push(format!(
            "  GeoIP / ASN : {} {} ({}, {})",
            geo["asn"].as_str().unwrap_or("-"),
            geo["isp"].as_str().unwrap_or("-"),
            geo["city"].as_str().unwrap_or("-"),
            geo["country"].as_str().unwrap_or("-")
        ));
    }
    let adapters = id["adapters"].as_array().map_or(0, Vec::len);
    lines.push(format!(
        "  Adapters    : {} detected | Fingerprint: {}",
        adapters,
        id["fingerprintSha256"]
            .as_str()
            .map_or("-", |s| &s[..s.len().min(16)])
    ));
    let dns_servers: Vec<&str> = dns["systemDnsServers"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    lines.push(format!(
        "  System DNS  : {} | Hosts overrides: {} | Leak: {}",
        if dns_servers.is_empty() {
            "none".to_string()
        } else {
            dns_servers.join(", ")
        },
        dns["hostsOverrideCount"].as_u64().unwrap_or(0),
        dns["leakStatus"].as_str().unwrap_or("unverified")
    ));
    if let Some(resolvers) = dns["resolvers"].as_array() {
        for r in resolvers {
            if let Some(p50) = r["p50Ms"].as_f64() {
                lines.push(format!(
                    "    resolver {:<12} ({:<14}): p50={:.1}ms p95={:.1}ms loss={:.0}%",
                    r["name"].as_str().unwrap_or("-"),
                    r["server"].as_str().unwrap_or("-"),
                    p50,
                    r["p95Ms"].as_f64().unwrap_or(0.0),
                    r["failureRatePct"].as_f64().unwrap_or(0.0)
                ));
            }
        }
    }
    if let Some(endpoints) = report["proxyTls"]["endpoints"].as_array() {
        for ep in endpoints {
            lines.push(format!(
                "    upstream {:<16}: status={:?} dns={:.1}ms tcp={:.1}ms tls={:.1}ms ttfb={:.1}ms",
                ep["label"].as_str().unwrap_or("-"),
                ep["httpStatus"].as_u64(),
                ep["dnsMs"].as_f64().unwrap_or(0.0),
                ep["tcpMs"].as_f64().unwrap_or(0.0),
                ep["tlsMs"].as_f64().unwrap_or(0.0),
                ep["ttfbMs"].as_f64().unwrap_or(0.0)
            ));
        }
    }
    let ram_tot_gb =
        host["hardware"]["total_ram_bytes"].as_u64().unwrap_or(0) as f64 / 1_073_741_824.0;
    let ram_avail_gb =
        host["hardware"]["available_ram_bytes"].as_u64().unwrap_or(0) as f64 / 1_073_741_824.0;
    let omnia_rss_mb =
        host["totalOmniaRssBytes"].as_u64().unwrap_or(0) as f64 / (1024.0 * 1024.0);
    lines.push(format!(
        "  Host        : CPU {:.1}% | RAM {:.1}/{:.1} GiB free | Omnia RSS {:.1} MiB | Ports {}",
        host["cpuLoadPct"].as_f64().unwrap_or(0.0),
        ram_avail_gb,
        ram_tot_gb,
        omnia_rss_mb,
        host["listeningPorts"].as_array().map_or(0, Vec::len)
    ));
    let out = lines.join("\n");
    if privacy_mask {
        println!("{}", PrivacyMask::mask_text(&out));
    } else {
        println!("{out}");
    }
    Ok(())
}

fn parse_speedtest_config(args: &[String]) -> SpeedtestConfig {
    let profile = if args.iter().any(|a| a == "--quick") {
        "quick"
    } else {
        "standard"
    };
    let mut cfg = SpeedtestConfig::for_profile(profile);
    if let Some(url) = arg_value(args, "--url") {
        cfg.base_url_override = Some(url);
    }
    cfg
}

fn run_speedtest_cmd(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia speedtest [--quick | --standard] [--url <override>] [--json] [--privacy-mask]"
        );
        return Ok(());
    }
    let cfg = parse_speedtest_config(args);
    let json_out = args.iter().any(|a| a == "--json");
    let privacy_mask = args.iter().any(|a| a == "--privacy-mask")
        || env::var("OMNIA_PRIVACY_MASK")
            .ok()
            .is_some_and(|v| matches!(v.trim(), "1" | "true" | "on"));
    let cancel = Arc::new(AtomicBool::new(false));
    let run_id = format!(
        "cli-st-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let result = run_speedtest_streaming(&run_id, &cfg, cancel, |ev| {
        if !json_out {
            let speed_note = ev
                .current_mbps
                .map_or_else(String::new, |m| format!(" | {m:.1} Mbps"));
            let rtt_note = ev
                .current_rtt_ms
                .map_or_else(String::new, |r| format!(" | RTT {r:.1} ms"));
            eprintln!(
                "  [{:>3}%] {:<14}{}{}: {}",
                ev.progress_pct, ev.phase, speed_note, rtt_note, ev.message
            );
        }
    });
    let val = serde_json::to_value(&result)?;
    let out_val = if privacy_mask {
        PrivacyMask::mask_json(&val)
    } else {
        val
    };
    if json_out {
        println!("{}", serde_json::to_string_pretty(&out_val)?);
        return Ok(());
    }
    let summary = format!(
        "Omnia Speedtest [{}] ({} | {}ms)\n  Download    : {:.2} Mbps (1-stream {:.2} / multi {:.2})\n  Upload      : {:.2} Mbps (1-stream {:.2} / multi {:.2})\n  Unloaded RTT: p50={:.1}ms p95={:.1}ms jitter={:.1}ms loss={:.1}%\n  Bufferbloat : Grade {} (DL +{:.1}ms / UL +{:.1}ms)\n  Readiness   : AI SSE {} ({}) | Git/Docker {} ({}) | WebRTC {} ({}) | Remote {} ({})",
        result.provenance.as_str(),
        result.profile,
        result.duration_ms,
        result.download_mbps,
        result.single_stream_dl_mbps,
        result.multi_stream_dl_mbps,
        result.upload_mbps,
        result.single_stream_ul_mbps,
        result.multi_stream_ul_mbps,
        result.unloaded.p50_ms.unwrap_or(0.0),
        result.unloaded.p95_ms.unwrap_or(0.0),
        result.unloaded.jitter_ms.unwrap_or(0.0),
        result.unloaded.loss_pct,
        result.bufferbloat_grade,
        result.dl_bufferbloat_delta_ms,
        result.ul_bufferbloat_delta_ms,
        result.workload_readiness.ai_sse_streaming.score,
        result.workload_readiness.ai_sse_streaming.rating,
        result.workload_readiness.git_docker_sync.score,
        result.workload_readiness.git_docker_sync.rating,
        result.workload_readiness.webrtc.score,
        result.workload_readiness.webrtc.rating,
        result.workload_readiness.remote_control.score,
        result.workload_readiness.remote_control.rating
    );
    if privacy_mask {
        println!("{}", PrivacyMask::mask_text(&summary));
    } else {
        println!("{summary}");
    }
    Ok(())
}

fn resolve_workspace_arg(args: &[String]) -> PathBuf {
    let raw = arg_value(args, "--workspace")
        .or_else(|| arg_value(args, "--cwd"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    sanitize_windows_path(&raw)
}

fn open_cli_research_vault(workspace: &std::path::Path) -> Result<omnia_harness::research_vault::ResearchVault> {
    let global_dir = default_omnia_data_dir().join("research-vault");
    omnia_harness::research_vault::ResearchVault::open(workspace, Some(&global_dir))
        .map_err(|e| anyhow::anyhow!(e))
}

fn open_cli_deep_think() -> Result<omnia_harness::deep_think::DeepThinkEngine> {
    let db_path = default_omnia_data_dir()
        .join("memory")
        .join("omnia_deep_think.db");
    omnia_harness::deep_think::DeepThinkEngine::open(&db_path).map_err(|e| anyhow::anyhow!(e))
}

fn open_cli_artifact_os(workspace: &std::path::Path) -> Result<omnia_harness::artifact_os::ArtifactOs> {
    let mem_dir = default_omnia_data_dir().join("memory");
    let db_path = mem_dir.join("omnia_artifact_os.db");
    omnia_harness::artifact_os::ArtifactOs::open(workspace, &db_path, Some(&mem_dir))
        .map_err(|e| anyhow::anyhow!(e))
}

fn run_research_cmd(args: &[String]) -> Result<()> {
    use omnia_agent::web_tools::{web_search_multi, WebSearchOptions, WebSearchScope};
    use omnia_harness::research_vault::VaultTier;

    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia research <query> [--workspace <dir>] [--scope web|academic|all] [--site <domain>] [--limit <n>] [--fetch] [--offline] [--export <path>] [--json]"
        );
        return Ok(());
    }
    let workspace = resolve_workspace_arg(args);
    let json_out = args.iter().any(|a| a == "--json");
    let offline = args.iter().any(|a| a == "--offline");
    let auto_fetch = args.iter().any(|a| a == "--fetch");
    let scope = WebSearchScope::parse(arg_value(args, "--scope").as_deref());
    let site = arg_value(args, "--site");
    let limit = arg_value(args, "--limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(6);
    let export_path = arg_value(args, "--export");
    let tier = VaultTier::from_str_lossy(arg_value(args, "--tier").as_deref().unwrap_or("local"));
    let query = extract_positional_prompt(args)
        .or_else(|| arg_value(args, "--query"))
        .unwrap_or_default();
    if query.trim().is_empty() {
        bail!("omnia research requires a query string");
    }

    let vault = open_cli_research_vault(&workspace)?;
    let rag_hits = vault.query_rag(&query, None, 6).unwrap_or_default();

    let (web_hits, fetched_sources, provider_errors) = if offline {
        (Vec::new(), Vec::new(), Vec::new())
    } else {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let bundle = rt.block_on(web_search_multi(&WebSearchOptions {
            query: query.clone(),
            limit,
            scope,
            site,
            ..Default::default()
        }))?;
        let mut urls = Vec::new();
        for h in &bundle.hits {
            let _ = vault.record_searched_candidate(tier, &h.canonical_url, &h.title, &query, &h.snippet);
            if urls.len() < 4 {
                urls.push(h.canonical_url.clone());
            }
        }
        let fetched = if auto_fetch && !urls.is_empty() {
            rt.block_on(vault.fetch_urls_parallel(tier, &urls, &query, 4, false))
        } else {
            Vec::new()
        };
        (bundle.hits, fetched, bundle.provider_errors)
    };

    let ledger = vault.sources_ledger(None).map_err(|e| anyhow::anyhow!(e))?;
    if let Some(ref ep) = export_path {
        let md = vault
            .export_dossier("markdown", None)
            .map_err(|e| anyhow::anyhow!(e))?;
        omnia_harness::research_vault::atomic_write_with_retry(std::path::Path::new(ep), md.as_bytes())
            .map_err(|e| anyhow::anyhow!(e))?;
    }

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": true,
                "query": query,
                "offline": offline,
                "ragHits": rag_hits,
                "webHits": web_hits,
                "fetchedSources": fetched_sources,
                "providerErrors": provider_errors,
                "ledger": ledger,
            }))?
        );
        return Ok(());
    }

    println!("Omnia Deep Research | query: `{query}`");
    println!(
        "  RAG Recall : {} hit(s) | Web/Academic: {} hit(s) | Fetched: {}",
        rag_hits.len(),
        web_hits.len(),
        fetched_sources.len()
    );
    for hit in rag_hits.iter().take(5) {
        println!("  [{}] {} — {}", hit.citation_id, hit.title, hit.source_url);
    }
    println!(
        "  Sources (Searched: {} | Viewed: {} | Extracted: {} | Blocked: {} | AuthReq: {} | Failed: {})",
        ledger.total_searched,
        ledger.total_viewed,
        ledger.total_extracted,
        ledger.total_blocked,
        ledger.total_auth_required,
        ledger.total_failed
    );
    Ok(())
}

fn run_rag_cmd(args: &[String]) -> Result<()> {
    use omnia_harness::research_vault::VaultTier;

    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia rag <query|sources|ingest|pin|export> [--workspace <dir>] [--tier local|global|both] [--json] ..."
        );
        return Ok(());
    }
    let sub = args[0].as_str();
    let rest = &args[1..];
    let workspace = resolve_workspace_arg(rest);
    let json_out = rest.iter().any(|a| a == "--json");
    let tier_raw = arg_value(rest, "--tier");
    let tier_filter = match tier_raw.as_deref().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("local") => Some(VaultTier::Local),
        Some("global") => Some(VaultTier::Global),
        _ => None,
    };
    let vault = open_cli_research_vault(&workspace)?;

    match sub {
        "sources" | "list" | "status" => {
            let ledger = vault.sources_ledger(tier_filter).map_err(|e| anyhow::anyhow!(e))?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&ledger)?);
            } else {
                println!(
                    "Omnia Persistent RAG | searched={} viewed={} extracted={} blocked={} auth_req={} failed={}",
                    ledger.total_searched,
                    ledger.total_viewed,
                    ledger.total_extracted,
                    ledger.total_blocked,
                    ledger.total_auth_required,
                    ledger.total_failed
                );
                for s in ledger.sources.iter().take(20) {
                    println!("  [{}] ({:?}) {} — {}", s.citation_id, s.stage, s.title, s.canonical_url);
                }
            }
        }
        "query" | "search" => {
            let q = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--query"))
                .context("omnia rag query requires a query string")?;
            let top_k = arg_value(rest, "--top-k")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(8);
            let hits = vault
                .query_rag(&q, tier_filter, top_k)
                .map_err(|e| anyhow::anyhow!(e))?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "query": q, "hits": hits }))?);
            } else {
                println!("RAG Query `{q}` -> {} hit(s):", hits.len());
                for h in hits {
                    println!("  [{}] rrf={:.4} {} ({})", h.citation_id, h.rrf_score, h.title, h.source_url);
                }
            }
        }
        "ingest" => {
            let url = arg_value(rest, "--url").context("omnia rag ingest requires --url <url>")?;
            let file = arg_value(rest, "--file");
            let content = if let Some(fp) = file {
                fs::read_to_string(&fp).with_context(|| format!("read {fp}"))?
            } else {
                arg_value(rest, "--content")
                    .or_else(|| extract_positional_prompt(rest))
                    .context("omnia rag ingest requires --file <path> or --content <text>")?
            };
            let title = arg_value(rest, "--title");
            let tier = VaultTier::from_str_lossy(tier_raw.as_deref().unwrap_or("local"));
            let rec = vault
                .ingest_document(tier, &url, None, title.as_deref(), &content, "text/markdown", Some(200), "cli_ingest")
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&rec)?);
        }
        "pin" => {
            let cid = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--id"))
                .context("omnia rag pin requires citation id e.g. S001")?;
            let target = VaultTier::from_str_lossy(tier_raw.as_deref().unwrap_or("global"));
            let rec = vault.pin_source(&cid, target).map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&rec)?);
        }
        "export" => {
            let fmt = if json_out { "json" } else { "markdown" };
            let out = vault.export_dossier(fmt, None).map_err(|e| anyhow::anyhow!(e))?;
            println!("{out}");
        }
        other => bail!("unknown omnia rag subcommand `{other}`"),
    }
    Ok(())
}

fn run_think_cmd(args: &[String]) -> Result<()> {
    use omnia_harness::deep_think::{BranchKind, EpistemicBand, ThinkBranch};

    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia think <list|start|branch|conclude> [--id <think_id>] [--effort max] [--json] ..."
        );
        return Ok(());
    }
    let sub = args[0].as_str();
    let rest = &args[1..];
    let json_out = rest.iter().any(|a| a == "--json");
    let eng = open_cli_deep_think()?;

    match sub {
        "list" | "status" => {
            let sessions = eng.list_sessions(None, 20).map_err(|e| anyhow::anyhow!(e))?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "sessions": sessions }))?);
            } else {
                println!("Omnia Deep Think Sessions ({}):", sessions.len());
                for s in sessions {
                    println!(
                        "  {} [{} | {} branches | effort={}] {}",
                        s.think_id,
                        s.stage,
                        s.branches.len(),
                        s.effort,
                        s.problem
                    );
                }
            }
        }
        "start" => {
            let problem = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--problem"))
                .context("omnia think start requires a problem description")?;
            let effort = arg_value(rest, "--effort").unwrap_or_else(|| "max".into());
            let sess = eng
                .start_session("cli", &problem, Vec::new(), Vec::new(), &effort)
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&sess)?);
        }
        "branch" => {
            let think_id = arg_value(rest, "--id").context("omnia think branch requires --id <think_id>")?;
            let title = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--title"))
                .unwrap_or_else(|| "Candidate Branch".into());
            let kind = BranchKind::from_str_lossy(arg_value(rest, "--kind").as_deref().unwrap_or("baseline"));
            let branch = ThinkBranch {
                branch_id: format!("br-{}", &omnia_core::uuid_v4()[..8]),
                kind,
                title,
                hypothesis: arg_value(rest, "--summary").unwrap_or_default(),
                complexity: arg_value(rest, "--complexity").unwrap_or_else(|| "O(N)".into()),
                failure_modes: Vec::new(),
                blast_radius: "localized".into(),
                citations: Vec::new(),
                epistemic_band: EpistemicBand::Hypothesis,
                falsification_cmd: None,
                falsification_passed: None,
                falsification_receipt: None,
                score_bps: 7_500,
                rejected_reason: None,
            };
            let sess = eng.add_branch(&think_id, branch).map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&sess)?);
        }
        "conclude" => {
            let think_id = arg_value(rest, "--id").context("omnia think conclude requires --id <think_id>")?;
            let winner = arg_value(rest, "--winner").context("omnia think conclude requires --winner <branch_id>")?;
            let synthesis = extract_positional_prompt(rest).unwrap_or_default();
            let sess = eng
                .conclude_session(&think_id, &winner, &synthesis, json!({ "verified": [winner] }))
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&sess)?);
        }
        other => bail!("unknown omnia think subcommand `{other}`"),
    }
    Ok(())
}

fn run_lifecycle_cmd(args: &[String]) -> Result<()> {
    use omnia_harness::artifact_os::{ArtifactKind, LessonRecord, SixStateReceipt};

    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia lifecycle <status|list|upsert|handoff|learn|lessons|gap-radar|super-state|verify> [--workspace <dir>] [--json] ..."
        );
        return Ok(());
    }
    let sub = args[0].as_str();
    let rest = &args[1..];
    let workspace = resolve_workspace_arg(rest);
    let json_out = rest.iter().any(|a| a == "--json");
    let sync_disk = rest.iter().any(|a| a == "--sync-disk");
    let aos = open_cli_artifact_os(&workspace)?;

    match sub {
        "status" => {
            let arts = aos.list_artifacts(None, None).map_err(|e| anyhow::anyhow!(e))?;
            let links = aos.list_all_links().map_err(|e| anyhow::anyhow!(e))?;
            let lessons = aos.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
            let super_st = aos.super_state().map_err(|e| anyhow::anyhow!(e))?;
            if json_out {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "ok": true,
                        "artifactCount": arts.len(),
                        "linkCount": links.len(),
                        "lessonCount": lessons.len(),
                        "superState": super_st,
                        "artifacts": arts,
                    }))?
                );
            } else {
                println!(
                    "Omnia Lifecycle OS | artifacts={} links={} lessons={} phase={} wave={} strikes={}",
                    arts.len(),
                    links.len(),
                    lessons.len(),
                    super_st.phase,
                    super_st.wave,
                    super_st.strike_count
                );
            }
        }
        "list" => {
            let kind = arg_value(rest, "--kind").and_then(|k| ArtifactKind::from_str_lossy(&k));
            let arts = aos.list_artifacts(kind, None).map_err(|e| anyhow::anyhow!(e))?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "artifacts": arts }))?);
            } else {
                for a in arts {
                    println!("  [{}] {} ({}) — {}", a.kind.as_str(), a.id, a.status, a.title);
                }
            }
        }
        "upsert" => {
            let kind_str = arg_value(rest, "--kind").context("omnia lifecycle upsert requires --kind <kind>")?;
            let kind = ArtifactKind::from_str_lossy(&kind_str)
                .ok_or_else(|| anyhow::anyhow!("unknown artifact kind `{kind_str}`"))?;
            let title = arg_value(rest, "--title").unwrap_or_else(|| kind_str.clone());
            let slug = arg_value(rest, "--id").unwrap_or_else(|| title.clone());
            let content = arg_value(rest, "--content")
                .or_else(|| extract_positional_prompt(rest))
                .unwrap_or_default();
            let art = aos
                .upsert_artifact(kind, &slug, &title, "active", "project", &content, json!({}), None, sync_disk)
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&art)?);
        }
        "handoff" => {
            let title = arg_value(rest, "--title").unwrap_or_else(|| "CLI Session Handoff".into());
            let content = arg_value(rest, "--content")
                .or_else(|| extract_positional_prompt(rest))
                .unwrap_or_else(|| "Checkpoint handoff".into());
            let art = aos
                .write_handoff_preserving_notes(&title, &content, SixStateReceipt::default(), sync_disk)
                .map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&art)?);
        }
        "learn" => {
            let title = arg_value(rest, "--title")
                .or_else(|| extract_positional_prompt(rest))
                .context("omnia lifecycle learn requires --title or text")?;
            let content = arg_value(rest, "--content").unwrap_or_else(|| title.clone());
            let scope = arg_value(rest, "--scope").unwrap_or_else(|| "project".into());
            let lesson = LessonRecord {
                id: format!("les-{}", &omnia_core::uuid_v4()[..8]),
                scope,
                title,
                symptom: content.clone(),
                root_cause: content.clone(),
                invariant: content,
                anti_pattern: String::new(),
                verify_cmd: String::new(),
                tags: Vec::new(),
                provenance_sha: String::new(),
                promoted_skill_slug: None,
                overlap_warning: None,
                created_at_ms: omnia_core::now_epoch_ms(),
            };
            let saved = aos.capture_lesson(lesson, sync_disk).map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&saved)?);
        }
        "lessons" => {
            let lessons = aos.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "lessons": lessons }))?);
        }
        "gap-radar" => {
            let rep = aos.gap_radar_report().map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&rep)?);
        }
        "super-state" => {
            let st = aos.super_state().map_err(|e| anyhow::anyhow!(e))?;
            println!("{}", serde_json::to_string_pretty(&st)?);
        }
        "verify" => {
            let file = arg_value(rest, "--file").or_else(|| extract_positional_prompt(rest));
            let content = if let Some(fp) = file {
                fs::read_to_string(&fp).with_context(|| format!("read {fp}"))?
            } else {
                arg_value(rest, "--content").context("omnia lifecycle verify requires --file or --content")?
            };
            let fg = arg_value(rest, "--fg");
            let bg = arg_value(rest, "--bg");
            let rep = omnia_harness::artifact_os::verify_artifact_content(
                &content,
                fg.as_deref(),
                bg.as_deref(),
                None,
            );
            println!("{}", serde_json::to_string_pretty(&rep)?);
        }
        other => bail!("unknown omnia lifecycle subcommand `{other}`"),
    }
    Ok(())
}

fn run_skills_cmd(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia skills <route|vault|dag|pipelines|doctor> [query] [--workspace <dir>] [--limit <n>] [--json]"
        );
        return Ok(());
    }
    let sub = args[0].as_str();
    let rest = &args[1..];
    let workspace = resolve_workspace_arg(rest);
    let json_out = rest.iter().any(|a| a == "--json");
    let limit = arg_value(rest, "--limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(8);
    let reg = omnia_harness::skill_registry::SkillRegistry::new();
    let _ = reg.load_from_workspace(&workspace);
    let _ = reg.load_default_cold_vault();

    match sub {
        "route" | "vault" => {
            let q = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--query"))
                .unwrap_or_default();
            let res = reg.search_with_vault(&q, limit, true);
            if json_out {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!("Omnia Skills Route `{q}`:\n{}", serde_json::to_string_pretty(&res)?);
            }
        }
        "dag" => {
            let q = extract_positional_prompt(rest)
                .or_else(|| arg_value(rest, "--query"))
                .unwrap_or_else(|| "deep research rust studio".into());
            let dag = reg.compose_4stage_dag(&q, 3);
            println!("{}", serde_json::to_string_pretty(&dag)?);
        }
        "pipelines" => {
            let pipes = reg.pipelines();
            if json_out {
                println!("{}", serde_json::to_string_pretty(&json!({ "ok": true, "pipelines": pipes }))?);
            } else {
                println!("Omnia Pre-Wired Pipelines ({}):", pipes.len());
                for p in pipes {
                    let skill_count: usize = p.stages.iter().map(|s| s.skills.len()).sum();
                    println!(
                        "  {} — {} ({} stages, {} skills)",
                        p.id,
                        p.title,
                        p.stages.len(),
                        skill_count
                    );
                }
            }
        }
        "doctor" => {
            let doc = reg.doctor();
            println!("{}", serde_json::to_string_pretty(&doc)?);
        }
        other => bail!("unknown omnia skills subcommand `{other}`"),
    }
    Ok(())
}

fn run_mcp_cmd(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia --mcp [--workspace <dir>]\n\nStarts the lightweight stdio JSON-RPC 2.0 MCP server exposing:\n  - omni_search_skills\n  - omni_load_skill (< 15.5 KB safe ceiling)\n  - graphify_query\n  - rag_search"
        );
        return Ok(());
    }
    let workspace = resolve_workspace_arg(args);
    mcp_server::run_mcp_stdio_server(&workspace)
}

fn run_learn_cmd(args: &[String]) -> Result<()> {
    use omnia_harness::artifact_os::LessonRecord;

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia learn <add|sync|status> [\"<lesson>\"] [--global] [--title <t>] [--cause <c>] [--invariant <i>] [--verify <cmd>] [--workspace <dir>] [--json]"
        );
        return Ok(());
    }
    let (sub, rest) = match args.first().map(String::as_str) {
        None => ("status", args),
        Some("status") => ("status", &args[1..]),
        Some("add") => ("add", &args[1..]),
        Some("sync") => ("sync", &args[1..]),
        Some(flag) if flag.starts_with("--") => ("status", args),
        Some(_) => ("add", args),
    };
    let workspace = resolve_workspace_arg(rest);
    let json_out = rest.iter().any(|a| a == "--json");
    let aos = open_cli_artifact_os(&workspace)?;
    let global_path = super_cmds::global_lessons_path();

    match sub {
        "status" => {
            let lessons = aos.list_lessons(None).map_err(|e| anyhow::anyhow!(e))?;
            let proj_count = lessons.iter().filter(|l| l.scope != "global").count();
            let glob_count = lessons.iter().filter(|l| l.scope == "global").count();
            let proj_path = super_cmds::project_lessons_path(&workspace);
            let payload = json!({
                "ok": true,
                "totalLessons": lessons.len(),
                "projectLessons": proj_count,
                "globalLessons": glob_count,
                "projectMirrorPath": proj_path.display().to_string(),
                "projectMirrorExists": proj_path.is_file(),
                "globalMirrorPath": global_path.display().to_string(),
                "globalMirrorExists": global_path.is_file(),
                "cap": super_cmds::GLOBAL_LESSONS_MAX_ENTRIES,
                "recent": lessons.iter().take(10).collect::<Vec<_>>(),
            });
            if json_out {
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                println!(
                    "Omnia Learn Status | total={} (project={} / global={}) | global_mirror={} (exists={})",
                    lessons.len(),
                    proj_count,
                    glob_count,
                    global_path.display(),
                    global_path.is_file()
                );
            }
        }
        "add" => {
            let is_global = rest.iter().any(|a| a == "--global" || a == "-g")
                || arg_value(rest, "--scope")
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case("global"));
            let scope = if is_global { "global" } else { "project" };
            let positional = extract_positional_prompt(rest);
            let title = arg_value(rest, "--title")
                .or_else(|| positional.clone())
                .context("omnia learn add requires lesson text or --title <text>")?;
            let cause = arg_value(rest, "--cause")
                .or_else(|| arg_value(rest, "--content"))
                .unwrap_or_else(|| title.clone());
            let invariant = arg_value(rest, "--invariant")
                .or(positional)
                .unwrap_or_else(|| title.clone());
            let verify_cmd = arg_value(rest, "--verify").unwrap_or_default();
            let rec = LessonRecord {
                id: format!("lsn-{}", &omnia_core::uuid_v4()[..8]),
                scope: scope.to_string(),
                title,
                symptom: cause.clone(),
                root_cause: cause,
                invariant,
                anti_pattern: String::new(),
                verify_cmd,
                tags: vec!["cli".to_string(), scope.to_string()],
                provenance_sha: String::new(),
                promoted_skill_slug: None,
                overlap_warning: None,
                created_at_ms: omnia_core::now_epoch_ms(),
            };
            let saved = aos
                .capture_lesson(rec, !is_global)
                .map_err(|e| anyhow::anyhow!(e))?;
            let mirror_count = if is_global {
                let globals = aos
                    .list_lessons(Some("global"))
                    .map_err(|e| anyhow::anyhow!(e))?;
                let c = super_cmds::mirror_lessons_markdown(
                    &global_path,
                    "Omnia Global Lessons",
                    &globals,
                    super_cmds::GLOBAL_LESSONS_MAX_ENTRIES,
                )?;
                if let Some(ch) = super_cmds::discover_cross_host_lessons_path() {
                    let _ = super_cmds::mirror_lessons_markdown(
                        &ch,
                        "Omnia Global Lessons",
                        &globals,
                        super_cmds::GLOBAL_LESSONS_MAX_ENTRIES,
                    );
                }
                c
            } else {
                0
            };
            let payload = json!({
                "ok": true,
                "lesson": saved,
                "globalMirrorPath": if is_global { Some(global_path.display().to_string()) } else { None },
                "globalMirrorCount": mirror_count,
            });
            if json_out {
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                println!(
                    "Captured {} lesson `{}` ({}){}",
                    saved.scope,
                    saved.title,
                    saved.id,
                    if is_global {
                        format!(" -> mirrored to {}", global_path.display())
                    } else {
                        String::new()
                    }
                );
            }
        }
        "sync" => {
            let cross = super_cmds::discover_cross_host_lessons_path();
            let rep =
                super_cmds::sync_lessons_to_paths(&aos, &workspace, &global_path, cross.as_deref())?;
            if json_out {
                println!("{}", serde_json::to_string_pretty(&rep)?);
            } else {
                println!(
                    "Synced lessons | total={} (project={} / global={}) | imported={} | global_mirror={} ({} entries)",
                    rep["totalLessons"].as_u64().unwrap_or(0),
                    rep["projectLessons"].as_u64().unwrap_or(0),
                    rep["globalLessons"].as_u64().unwrap_or(0),
                    rep["importedFromDisk"].as_u64().unwrap_or(0),
                    rep["globalMirrorPath"].as_str().unwrap_or("-"),
                    rep["globalMirrorCount"].as_u64().unwrap_or(0),
                );
            }
        }
        other => bail!("unknown omnia learn subcommand `{other}` (expected: add | sync | status)"),
    }
    Ok(())
}

fn run_proceed_cmd(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia proceed [status|on|off|recommended-only|full] [--workspace <dir>] [--json]"
        );
        return Ok(());
    }
    let workspace = resolve_workspace_arg(args);
    let json_out = args.iter().any(|a| a == "--json");
    let action_owned = extract_positional_prompt(args).unwrap_or_else(|| "status".to_string());
    let action = action_owned.split_whitespace().next().unwrap_or("status");

    if action.eq_ignore_ascii_case("status") {
        let state = super_cmds::read_engine_state(&workspace);
        let path = super_cmds::engine_state_path(&workspace);
        let payload = json!({
            "ok": true,
            "path": path.display().to_string(),
            "exists": path.is_file(),
            "state": state,
        });
        if json_out {
            println!("{}", serde_json::to_string_pretty(&payload)?);
        } else {
            println!(
                "Omnia Auto-Proceed | mode={} | autoProceed={} (enabled={}) | tokenBudget=null | {}",
                state.mode,
                state.auto_proceed.as_str(),
                state.auto_proceed_enabled,
                path.display()
            );
        }
        return Ok(());
    }

    let mode = super_cmds::AutoProceedMode::try_parse(action)?;
    let (state, path) = super_cmds::set_auto_proceed(&workspace, mode)?;
    let payload = json!({
        "ok": true,
        "path": path.display().to_string(),
        "state": state,
    });
    if json_out {
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else {
        println!(
            "Updated autoProceed -> {} (enabled={}, tokenBudget=null) in {}",
            state.auto_proceed.as_str(),
            state.auto_proceed_enabled,
            path.display()
        );
    }
    Ok(())
}

fn parse_cli_arena_models(raw: Option<&str>) -> Result<Vec<String>> {
    let default_pair = "claude-sonnet-5-5,gpt-6.2-sol";
    let src = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(default_pair);
    let mut models = Vec::new();
    for m in src.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !models.iter().any(|existing: &String| existing.eq_ignore_ascii_case(m)) {
            models.push(m.to_string());
        }
    }
    if models.len() < 2 {
        bail!("omnia arena requires 2..=4 comma-separated models via --models <m1,m2[,m3,m4]>");
    }
    if models.len() > 4 {
        bail!("omnia arena supports at most 4 models per parallel run (got {})", models.len());
    }
    Ok(models)
}

fn estimate_arena_model_diagnostic(
    model_spec: &str,
    prompt: &str,
    config_dir: Option<&std::path::Path>,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> serde_json::Value {
    let input_tokens = (prompt.len().div_ceil(4) as u64).max(1);
    let est_output_tokens = (input_tokens * 2).clamp(64, 1_024);
    let resolved = resolve_model_endpoint(model_spec, config_dir, base_url, api_key);
    let (provider_id, model_id, context_window, in_rate, out_rate) = match resolved {
        Ok(ep) => (
            ep.provider_id,
            ep.model_id,
            ep.context_window,
            ep.cost_input_per_m,
            ep.cost_output_per_m,
        ),
        Err(_) => ("unconfigured".to_string(), model_spec.to_string(), 200_000, 3.0, 15.0),
    };
    let est_cost_usd = ((input_tokens as f64 / 1_000_000.0) * in_rate
        + (est_output_tokens as f64 / 1_000_000.0) * out_rate)
        .max(0.0);
    let rounded_cost = (est_cost_usd * 1_000_000.0).round() / 1_000_000.0;
    json!({
        "model": model_id,
        "providerId": provider_id,
        "status": "unconfigured_provider",
        "configured": false,
        "elapsedMs": 0,
        "inputTokens": input_tokens,
        "estimatedOutputTokens": est_output_tokens,
        "outputTokens": 0,
        "tokensPerSecond": 0.0,
        "estimatedCostUsd": rounded_cost,
        "costUsd": 0.0,
        "contextWindow": context_window,
        "text": serde_json::Value::Null,
        "note": "No API key configured — set OMNIA_API_KEY/HTMUSTC_API_KEY or pass --api-key (zero fabricated answers)."
    })
}

fn run_arena_cmd(args: &[String]) -> Result<()> {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Usage: omnia arena \"<prompt>\" --models <m1,m2[,m3,m4]> [--effort max] [--temperature 0.7] [--workspace <dir>] [--base-url <url>] [--api-key <key>] [--wire-api <mode>] [--timeout-secs <s>] [--offline] [--json]"
        );
        return Ok(());
    }
    let prompt = extract_positional_prompt(args)
        .or_else(|| arg_value(args, "--prompt"))
        .unwrap_or_default();
    if prompt.trim().is_empty() {
        bail!("omnia arena requires a prompt string");
    }
    let models = parse_cli_arena_models(arg_value(args, "--models").as_deref())?;
    let effort = resolve_effort_arg(args);
    let temperature: f64 = match arg_value(args, "--temperature") {
        Some(raw) => {
            let v: f64 = raw.parse().context("invalid float for --temperature")?;
            if !(0.0..=2.0).contains(&v) {
                bail!("--temperature must be between 0.0 and 2.0");
            }
            v
        }
        None => 0.7,
    };
    let json_out = args.iter().any(|a| a == "--json");
    let offline = args.iter().any(|a| a == "--offline");
    let workspace = resolve_workspace_arg(args);
    let config_dir = arg_value(args, "--config-dir").map(PathBuf::from);
    let base_url = arg_value(args, "--base-url")
        .or_else(|| arg_value(args, "--api-base"))
        .or_else(|| env::var("OMNIA_BASE_URL").ok().filter(|s| !s.trim().is_empty()));
    let explicit_key = arg_value(args, "--api-key")
        .or_else(|| env::var("OMNIA_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("HTMUSTC_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("OPENAI_API_KEY").ok().filter(|s| !s.trim().is_empty()));
    let wire_api = arg_value(args, "--wire-api")
        .map(|s| WireApiMode::parse_flag(&s))
        .unwrap_or(WireApiMode::Auto);
    let timeout_secs = arg_value(args, "--timeout-secs")
        .or_else(|| arg_value(args, "--timeout"))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(90)
        .clamp(10, 180);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let results: Vec<serde_json::Value> = rt.block_on(async {
        let mut set = tokio::task::JoinSet::new();
        for (idx, model_spec) in models.iter().cloned().enumerate() {
            let ws = workspace.clone();
            let cfg_dir = config_dir.clone();
            let b_url = base_url.clone();
            let key = explicit_key.clone();
            let eff = effort.clone();
            let p_str = prompt.clone();
            set.spawn(async move {
                let resolved = resolve_model_endpoint(
                    &model_spec,
                    cfg_dir.as_deref(),
                    b_url.as_deref(),
                    key.as_deref(),
                );
                let live_ep = if offline {
                    None
                } else {
                    resolved.ok().filter(|ep| !ep.api_key.trim().is_empty())
                };
                let Some(ep) = live_ep else {
                    return (
                        idx,
                        estimate_arena_model_diagnostic(
                            &model_spec,
                            &p_str,
                            cfg_dir.as_deref(),
                            b_url.as_deref(),
                            key.as_deref(),
                        ),
                    );
                };

                let t0 = Instant::now();
                let cancel = Arc::new(AtomicBool::new(false));
                let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(&ws)));
                let session_key = format!("cli-arena-{idx}");
                let model_lbl = ep.model_id.clone();
                let provider_lbl = ep.provider_id.clone();
                let context_window = ep.context_window;
                let eng_res = NativeSuperEngine::new(
                    session_key,
                    ws,
                    ep,
                    eff,
                    ApprovalMode::Plan,
                    true,
                    PermissionsEngine::default_rules(),
                    PluginRegistry::with_default_pillars(),
                    graph,
                    None,
                    None,
                    cancel,
                    None,
                );
                let val = match eng_res {
                    Ok(mut eng) => {
                        eng.wire_api_mode = wire_api;
                        match eng.run_prompt(&p_str, 1, timeout_secs, None).await {
                            Ok(sum) => {
                                let cs = eng.cache_guard.snapshot();
                                let tps = if sum.active_decode_ms > 0 {
                                    (cs.output_tokens as f64)
                                        / (sum.active_decode_ms as f64 / 1000.0)
                                } else {
                                    0.0
                                };
                                json!({
                                    "model": model_lbl,
                                    "providerId": provider_lbl,
                                    "status": "ok",
                                    "configured": true,
                                    "elapsedMs": t0.elapsed().as_millis() as u64,
                                    "inputTokens": cs.uncached_input_tokens + cs.cache_read_tokens,
                                    "outputTokens": cs.output_tokens,
                                    "tokensPerSecond": (tps * 10.0).round() / 10.0,
                                    "costUsd": (eng.total_cost_usd * 1_000_000.0).round() / 1_000_000.0,
                                    "contextWindow": context_window,
                                    "text": redact_secrets(&sum.final_text),
                                })
                            }
                            Err(e) => json!({
                                "model": model_lbl,
                                "providerId": provider_lbl,
                                "status": "error",
                                "configured": true,
                                "elapsedMs": t0.elapsed().as_millis() as u64,
                                "costUsd": (eng.total_cost_usd * 1_000_000.0).round() / 1_000_000.0,
                                "contextWindow": context_window,
                                "error": redact_secrets(&format!("{e:#}")),
                                "text": serde_json::Value::Null,
                            }),
                        }
                    }
                    Err(e) => json!({
                        "model": model_lbl,
                        "providerId": provider_lbl,
                        "status": "error",
                        "configured": true,
                        "elapsedMs": t0.elapsed().as_millis() as u64,
                        "costUsd": 0.0,
                        "contextWindow": context_window,
                        "error": redact_secrets(&format!("{e:#}")),
                        "text": serde_json::Value::Null,
                    }),
                };
                (idx, val)
            });
        }
        let mut ordered = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(item) = joined {
                ordered.push(item);
            }
        }
        ordered.sort_by_key(|(idx, _)| *idx);
        ordered.into_iter().map(|(_, v)| v).collect()
    });

    let payload = json!({
        "ok": true,
        "prompt": redact_secrets(&prompt),
        "models": models,
        "effort": effort.as_deref().unwrap_or("auto"),
        "temperature": temperature,
        "offline": offline,
        "results": results,
    });
    if json_out {
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    println!(
        "Omnia Parallel Arena ({} models | effort={} | temp={:.2})",
        models.len(),
        effort.as_deref().unwrap_or("auto"),
        temperature
    );
    if let Some(arr) = payload["results"].as_array() {
        for r in arr {
            let cost = r["costUsd"]
                .as_f64()
                .filter(|c| *c > 0.0)
                .or_else(|| r["estimatedCostUsd"].as_f64())
                .unwrap_or(0.0);
            println!(
                "  {} [{}] {}ms | in:{} out:{} | {:.1} tok/s | ${:.6}",
                r["model"].as_str().unwrap_or("-"),
                r["status"].as_str().unwrap_or("-"),
                r["elapsedMs"].as_u64().unwrap_or(0),
                r["inputTokens"].as_u64().unwrap_or(0),
                r["outputTokens"].as_u64().unwrap_or(0),
                r["tokensPerSecond"].as_f64().unwrap_or(0.0),
                cost
            );
            if let Some(txt) = r["text"].as_str() {
                let preview: String = txt.chars().take(180).collect();
                println!("    {}", preview.replace('\n', " "));
            } else if let Some(note) = r["note"].as_str().or_else(|| r["error"].as_str()) {
                println!("    {note}");
            }
        }
    }
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
    // Steer #22 full-freedom default: YOLO (auto-approve, unrestricted) unless explicitly restricted.
    Ok(ApprovalMode::Yolo)
}

/// Resolves `(approval_mode, workspace_trusted, permission_rules, sandbox_enabled)`.
/// Default remains `ApprovalMode::Yolo` + trusted workspace + empty default rules (`Z-01`/`Z-02`).
/// `--sandbox` is strictly opt-in and enables `PermissionsEngine::strict_safety_rules()` + untrusted workspace gate.
fn resolve_run_security_policy(
    args: &[String],
) -> Result<(ApprovalMode, bool, Vec<PermissionRule>, bool)> {
    let sandbox_enabled = args.iter().any(|a| a == "--sandbox");
    if !sandbox_enabled {
        return Ok((
            resolve_approval_mode(args)?,
            true,
            PermissionsEngine::default_rules(),
            false,
        ));
    }
    let has_explicit_approval = args.iter().any(|a| {
        a == "--auto-approve" || a == "--approval-mode" || a.starts_with("--approval-mode=")
    });
    let approval_mode = if has_explicit_approval {
        resolve_approval_mode(args)?
    } else {
        ApprovalMode::Write
    };
    Ok((
        approval_mode,
        false,
        PermissionsEngine::strict_safety_rules(),
        true,
    ))
}

fn resolve_effort_arg(args: &[String]) -> Option<String> {
    let raw = arg_value(args, "--effort")
        .or_else(|| arg_value(args, "--reasoning-effort"))
        .or_else(|| arg_value(args, "--thinking"))
        .or_else(|| env::var("OMNIA_EFFORT").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| {
            env::var("OMNIA_REASONING_EFFORT")
                .ok()
                .filter(|s| !s.trim().is_empty())
        });
    match raw {
        Some(v) => {
            let trimmed = v.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
                None
            } else {
                Some(trimmed.to_ascii_lowercase())
            }
        }
        None => Some("max".to_string()),
    }
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
            "--effort",
            "xhigh",
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
        assert_eq!(resolve_effort_arg(&args).as_deref(), Some("xhigh"));
        assert_eq!(
            extract_positional_prompt(&args).as_deref(),
            Some("Fix failing test in ledger.py")
        );
        assert_eq!(resolve_approval_mode(&args).unwrap(), ApprovalMode::Yolo);
    }

    #[test]
    fn cli_effort_flag_defaults_to_max_and_supports_aliases_and_auto() {
        let bare: Vec<String> = vec!["--model".into(), "gpt-6.2-sol".into(), "hi".into()];
        assert_eq!(resolve_effort_arg(&bare).as_deref(), Some("max"));

        let alias: Vec<String> = vec![
            "--reasoning-effort".into(),
            "MEDIUM".into(),
            "solve task".into(),
        ];
        assert_eq!(resolve_effort_arg(&alias).as_deref(), Some("medium"));
        assert_eq!(
            extract_positional_prompt(&alias).as_deref(),
            Some("solve task")
        );

        let eq_flag: Vec<String> = vec!["--effort=low".into(), "prompt".into()];
        assert_eq!(resolve_effort_arg(&eq_flag).as_deref(), Some("low"));

        let auto_flag: Vec<String> = vec!["--effort".into(), "auto".into(), "prompt".into()];
        assert_eq!(resolve_effort_arg(&auto_flag), None);

        let legacy: Vec<String> = vec!["--thinking".into(), "high".into(), "prompt".into()];
        assert_eq!(resolve_effort_arg(&legacy).as_deref(), Some("high"));
    }

    #[test]
    fn cli_approval_mode_defaults_to_yolo_and_honors_opt_ins_and_rejects_typos() {
        let bare: Vec<String> = vec!["--model".into(), "gpt-6.2-sol".into(), "hello".into()];
        assert_eq!(resolve_approval_mode(&bare).unwrap(), ApprovalMode::Yolo);

        for alias in [
            "yolo",
            "turbo",
            "full-access",
            "full",
            "unrestricted",
            "auto",
            "auto-approve",
        ] {
            let a: Vec<String> = vec!["--approval-mode".into(), alias.into()];
            assert_eq!(resolve_approval_mode(&a).unwrap(), ApprovalMode::Yolo);
        }

        let typo: Vec<String> = vec!["--approval-mode".into(), "yollo".into()];
        assert!(resolve_approval_mode(&typo).is_err());

        let write_mode: Vec<String> = vec!["--approval-mode".into(), "write".into()];
        assert_eq!(resolve_approval_mode(&write_mode).unwrap(), ApprovalMode::Write);

        let plan_mode: Vec<String> = vec!["--approval-mode".into(), "plan".into()];
        assert_eq!(resolve_approval_mode(&plan_mode).unwrap(), ApprovalMode::Plan);

        let ask_mode: Vec<String> = vec!["--approval-mode".into(), "always-ask".into()];
        assert_eq!(resolve_approval_mode(&ask_mode).unwrap(), ApprovalMode::AlwaysAsk);

        let cached_mode: Vec<String> = vec!["--approval-mode".into(), "always-ask-cached".into()];
        assert_eq!(
            resolve_approval_mode(&cached_mode).unwrap(),
            ApprovalMode::AlwaysAskCached
        );
    }

    #[test]
    fn cli_net_offline_report_and_speedtest_config_honor_privacy_mask() {
        let rep = build_net_report_json(true, false, false, 1_000, true);
        assert_eq!(rep["privacyMasked"], json!(true));
        assert!(rep["identity"]["fingerprintSha256"].is_string());
        assert!(rep["host"]["hardware"]["logical_cpus"].as_u64().unwrap_or(0) >= 1);

        let quick_args: Vec<String> = vec![
            "--quick".into(),
            "--url".into(),
            "http://127.0.0.1:19999".into(),
        ];
        let cfg = parse_speedtest_config(&quick_args);
        assert_eq!(cfg.profile, "quick");
        assert_eq!(cfg.base_url_override.as_deref(), Some("http://127.0.0.1:19999"));
    }

    #[test]
    fn cli_steer18_20_adaptive_flags_and_positional_extraction_work_cleanly() {
        let args: Vec<String> = vec![
            "--workspace",
            r"D:\Omnia",
            "--research",
            "deep",
            "--think",
            "auto",
            "--proactive-lifecycle",
            "on",
            "--scope",
            "academic",
            "Rust KV cache invariance",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            omnia_agent::engine::AdaptiveMode::parse(arg_value(&args, "--research").as_deref()),
            omnia_agent::engine::AdaptiveMode::Deep
        );
        assert_eq!(
            omnia_agent::engine::AdaptiveMode::parse(arg_value(&args, "--think").as_deref()),
            omnia_agent::engine::AdaptiveMode::Auto
        );
        assert_eq!(
            extract_positional_prompt(&args).as_deref(),
            Some("Rust KV cache invariance")
        );
    }

    #[test]
    fn cli_arena_parser_and_unconfigured_diagnostic_work_without_fabricating() {
        let arena_args: Vec<String> = vec![
            "Compare Rust WAL vs LMDB",
            "--models",
            "claude-sonnet-5-5,gpt-6.2-sol,gpt-6.2-sol",
            "--effort",
            "max",
            "--temperature",
            "0.7",
            "--json",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            extract_positional_prompt(&arena_args).as_deref(),
            Some("Compare Rust WAL vs LMDB")
        );
        let models = parse_cli_arena_models(arg_value(&arena_args, "--models").as_deref()).unwrap();
        assert_eq!(models, vec!["claude-sonnet-5-5", "gpt-6.2-sol"]);
        assert!(parse_cli_arena_models(Some("only-one")).is_err());
        assert!(parse_cli_arena_models(Some("m1,m2,m3,m4,m5")).is_err());

        let diag = estimate_arena_model_diagnostic(
            "claude-sonnet-5-5",
            "Compare Rust WAL vs LMDB",
            None,
            None,
            None,
        );
        assert_eq!(diag["status"], json!("unconfigured_provider"));
        assert_eq!(diag["configured"], json!(false));
        assert!(diag["inputTokens"].as_u64().unwrap_or(0) >= 1);
        assert!(diag["estimatedCostUsd"].as_f64().unwrap_or(-1.0) >= 0.0);
        assert!(diag["text"].is_null());
    }

    #[test]
    fn cli_sandbox_flag_is_strictly_opt_in_and_preserves_yolo_default() {
        let bare: Vec<String> = vec!["Fix bug".into()];
        let (mode, trusted, rules, sandbox) = resolve_run_security_policy(&bare).unwrap();
        assert_eq!(mode, ApprovalMode::Yolo);
        assert!(trusted);
        assert!(rules.is_empty());
        assert!(!sandbox);

        let sandboxed: Vec<String> = vec!["--sandbox".into(), "Fix bug".into()];
        let (s_mode, s_trusted, s_rules, s_on) = resolve_run_security_policy(&sandboxed).unwrap();
        assert_eq!(s_mode, ApprovalMode::Write);
        assert!(!s_trusted);
        assert!(!s_rules.is_empty());
        assert!(s_on);

        // Explicit --approval-mode still works with --sandbox while strict deny rules stay active.
        let sandbox_yolo: Vec<String> = vec![
            "--sandbox".into(),
            "--approval-mode".into(),
            "yolo".into(),
            "Fix bug".into(),
        ];
        let (sy_mode, sy_trusted, sy_rules, sy_on) =
            resolve_run_security_policy(&sandbox_yolo).unwrap();
        assert_eq!(sy_mode, ApprovalMode::Yolo);
        assert!(!sy_trusted);
        assert_eq!(sy_rules.len(), PermissionsEngine::strict_safety_rules().len());
        assert!(sy_on);
    }
}
