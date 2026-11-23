//! Interactive Pure-Rust Terminal UI (TUI) for `omnia`.
//!
//! Launches when `omnia` is invoked without a subcommand (or via `omnia tui`),
//! matching the interactive session UX of Codex, Claude Code, OpenCode, OMP, and AGY
//! with `<15 ms` startup, `<10 MiB` binary, and persistent multi-turn KV-cache state.

use anyhow::{Context, Result};
use omnia_agent::{
    default_omnia_data_dir, process_tree_rss_bytes, redact_secrets, resolve_model_endpoint,
    sanitize_windows_path, AgentStore, ApprovalMode, HarnessEventSink, HarnessStreamEvent,
    NativeSuperEngine, PermissionsEngine, PluginRegistry, WireApiMode, WorkspaceGraphIndex,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://htmustc.id.vn/v1";
const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const MAGENTA: &str = "\x1b[35m";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CliSavedConfig {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub wire_api: Option<String>,
    pub approval_mode: Option<String>,
    pub thinking: Option<String>,
}

pub struct TuiLaunchOptions {
    pub workspace: PathBuf,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub wire_api: Option<WireApiMode>,
    pub thinking: Option<String>,
    pub approval_mode: Option<ApprovalMode>,
    pub max_turns: u32,
    pub timeout_secs: u64,
}

#[cfg(windows)]
fn enable_windows_vt() {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
        STD_OUTPUT_HANDLE,
    };
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if !handle.is_null() {
            let mut mode = 0u32;
            if GetConsoleMode(handle, &mut mode) != 0 {
                let _ = SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
            }
        }
    }
}

#[cfg(not(windows))]
fn enable_windows_vt() {}

fn config_path() -> PathBuf {
    if let Ok(home) = env::var("OMNIA_HOME").or_else(|_| env::var("USERPROFILE")) {
        return PathBuf::from(home).join(".omnia").join("cli_config.json");
    }
    default_omnia_data_dir().join("cli_config.json")
}

fn load_saved_config() -> CliSavedConfig {
    let path = config_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &CliSavedConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&path, json).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn format_approval(m: ApprovalMode) -> &'static str {
    match m {
        ApprovalMode::Plan => "plan",
        ApprovalMode::AlwaysAsk => "always-ask",
        ApprovalMode::AlwaysAskCached => "always-ask-cached",
        ApprovalMode::Write => "write",
        ApprovalMode::Yolo => "yolo",
    }
}

fn parse_approval(raw: &str) -> Option<ApprovalMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "yolo" | "auto" => Some(ApprovalMode::Yolo),
        "write" => Some(ApprovalMode::Write),
        "plan" => Some(ApprovalMode::Plan),
        "always-ask" | "ask" => Some(ApprovalMode::AlwaysAsk),
        "always-ask-cached" => Some(ApprovalMode::AlwaysAskCached),
        _ => None,
    }
}

fn print_banner(
    workspace: &Path,
    model: &str,
    base_url: &str,
    wire: WireApiMode,
    approval: ApprovalMode,
    has_key: bool,
) {
    let rss_mb = process_tree_rss_bytes(std::process::id()) as f64 / (1024.0 * 1024.0);
    println!();
    println!(
        "{BOLD}{CYAN}╭──────────────────────────────────────────────────────────────────────╮{RESET}"
    );
    println!(
        "{BOLD}{CYAN}│{RESET} {BOLD}OMNIA v{}{RESET} {DIM}— Pure Native Rust Super-Harness TUI ({rss_mb:.1} MiB RSS){RESET}",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "{BOLD}{CYAN}├──────────────────────────────────────────────────────────────────────┤{RESET}"
    );
    println!(
        "{BOLD}{CYAN}│{RESET} {DIM}Workspace:{RESET} {}",
        workspace.display()
    );
    println!(
        "{BOLD}{CYAN}│{RESET} {DIM}Model:{RESET}     {GREEN}{model}{RESET}  {DIM}Wire:{RESET} {wire:?}  {DIM}Mode:{RESET} {YELLOW}{}{RESET}",
        format_approval(approval)
    );
    println!(
        "{BOLD}{CYAN}│{RESET} {DIM}Provider:{RESET}  {base_url}  {DIM}Key:{RESET} {}",
        if has_key {
            format!("{GREEN}configured{RESET}")
        } else {
            format!("{RED}missing (run /key <your-key>){RESET}")
        }
    );
    println!(
        "{BOLD}{CYAN}╰──────────────────────────────────────────────────────────────────────╯{RESET}"
    );
    println!(
        "{DIM}Type a prompt to start, `\"\"\"` for multi-line, or `/help` for commands (`/exit` to quit).{RESET}\n"
    );
}

fn print_tui_help() {
    println!(
        "\n{BOLD}Omnia TUI Commands:{RESET}
  {CYAN}/help{RESET}                   Show this command list
  {CYAN}/model <id>{RESET}             Switch model (e.g. claude-sonnet-5-5, gemini-3.8-flash, gpt-6.2-sol)
  {CYAN}/wire <mode>{RESET}            Switch wire API (auto | chat | responses | messages | gemini)
  {CYAN}/thinking <level>{RESET}       Set thinking level (off | minimal | low | medium | high)
  {CYAN}/mode <approval>{RESET}        Set approval mode (yolo | write | plan | always-ask)
  {CYAN}/cd <dir>{RESET}               Change workspace directory (resets session cleanly)
  {CYAN}/key <api_key>{RESET}          Set & save API key to ~/.omnia/cli_config.json
  {CYAN}/base-url <url>{RESET}         Set & save provider base URL (default: {DEFAULT_BASE_URL})
  {CYAN}/rewind <turn>{RESET}          Rewind workspace files & history to checkpoint turn N
  {CYAN}/status{RESET}                 Show session turns, tokens, KV-cache hit %, tool errors, RSS
  {CYAN}/clear{RESET}                  Clear conversation history and start a fresh session
  {CYAN}/exit{RESET} | {CYAN}/quit{RESET}           Exit Omnia TUI\n"
    );
}

#[allow(clippy::too_many_arguments)]
fn build_engine(
    workspace: &Path,
    model: &str,
    base_url: &str,
    api_key: Option<&str>,
    wire_api: WireApiMode,
    thinking: Option<String>,
    approval_mode: ApprovalMode,
    db: Option<AgentStore>,
) -> Result<NativeSuperEngine> {
    let endpoint = resolve_model_endpoint(model, None, Some(base_url), api_key)?;
    let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(workspace)));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let session_key = format!("tui-{}", uuid_like_id());

    let approver = Some(Arc::new(move |tool_name: String, reason: String| {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                print!(
                    "\n{YELLOW}[Approval Required]{RESET} tool `{BOLD}{tool_name}{RESET}` ({reason}). Allow? [y/N]: "
                );
                let _ = io::stdout().flush();
                let mut line = String::new();
                if io::stdin().read_line(&mut line).is_err() {
                    return false;
                }
                let ans = line.trim().to_ascii_lowercase();
                ans == "y" || ans == "yes"
            })
            .await
            .unwrap_or(false)
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
    }) as _);

    let mut eng = NativeSuperEngine::new(
        session_key,
        workspace.to_path_buf(),
        endpoint,
        thinking,
        approval_mode,
        approval_mode == ApprovalMode::Yolo,
        PermissionsEngine::default_rules(),
        PluginRegistry::with_default_pillars(),
        graph,
        db,
        approver,
        cancel_flag,
        None,
    )?;
    eng.wire_api_mode = wire_api;
    Ok(eng)
}

fn uuid_like_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{ns:x}")
}

fn read_user_input(stdin: &io::Stdin, workspace: &Path, model: &str) -> Result<Option<String>> {
    let ws_name = workspace
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(".");
    print!("{BOLD}{CYAN}{ws_name}{RESET} {DIM}[{model}]{RESET} {BOLD}›{RESET} ");
    io::stdout().flush()?;

    let mut line = String::new();
    let n = stdin.lock().read_line(&mut line)?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
    if trimmed == "\"\"\"" {
        println!("{DIM}(multi-line mode: end with `\"\"\"` on its own line){RESET}");
        let mut buf = Vec::new();
        loop {
            print!("{DIM}...{RESET} ");
            io::stdout().flush()?;
            let mut next = String::new();
            if stdin.lock().read_line(&mut next)? == 0 {
                break;
            }
            if next.trim_end_matches(&['\r', '\n'][..]) == "\"\"\"" {
                break;
            }
            buf.push(next);
        }
        return Ok(Some(buf.concat()));
    }
    if let Some(prefix) = trimmed.strip_suffix('\\') {
        let mut buf = String::from(prefix);
        buf.push('\n');
        loop {
            print!("{DIM}...{RESET} ");
            io::stdout().flush()?;
            let mut next = String::new();
            if stdin.lock().read_line(&mut next)? == 0 {
                break;
            }
            let t = next.trim_end_matches(&['\r', '\n'][..]);
            if let Some(p) = t.strip_suffix('\\') {
                buf.push_str(p);
                buf.push('\n');
            } else {
                buf.push_str(t);
                break;
            }
        }
        return Ok(Some(buf));
    }
    Ok(Some(trimmed.to_string()))
}

pub async fn run_interactive_tui(opts: TuiLaunchOptions) -> Result<()> {
    enable_windows_vt();
    let mut saved = load_saved_config();

    let mut workspace = sanitize_windows_path(&opts.workspace);
    let mut model = opts
        .model
        .or_else(|| env::var("OMNIA_MODEL").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.model.clone())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let mut base_url = opts
        .base_url
        .or_else(|| env::var("OMNIA_BASE_URL").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.base_url.clone())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let mut api_key = opts
        .api_key
        .or_else(|| env::var("OMNIA_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("HTMUSTC_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("OPENAI_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.api_key.clone());
    let mut wire_api = opts
        .wire_api
        .or_else(|| saved.wire_api.as_deref().map(WireApiMode::parse_flag))
        .unwrap_or(WireApiMode::Auto);
    let mut thinking = opts.thinking.or_else(|| saved.thinking.clone());
    let mut approval_mode = opts
        .approval_mode
        .or_else(|| saved.approval_mode.as_deref().and_then(parse_approval))
        .unwrap_or(ApprovalMode::Write);

    let data_dir = default_omnia_data_dir();
    let db = AgentStore::open(&data_dir)
        .or_else(|_| AgentStore::open_in_memory())
        .ok();

    let mut engine = build_engine(
        &workspace,
        &model,
        &base_url,
        api_key.as_deref(),
        wire_api,
        thinking.clone(),
        approval_mode,
        db.clone(),
    )?;

    print_banner(
        &workspace,
        &model,
        &base_url,
        wire_api,
        approval_mode,
        api_key.as_deref().is_some_and(|k| !k.trim().is_empty()),
    );

    let stdin = io::stdin();
    while let Some(input) = read_user_input(&stdin, &workspace, &model)? {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with('/') {
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let cmd = parts.next().unwrap_or("");
            let arg = parts.next().map(str::trim).unwrap_or("");
            match cmd {
                "/exit" | "/quit" | "/q" => {
                    println!("{DIM}Goodbye.{RESET}");
                    break;
                }
                "/help" | "/?" => {
                    print_tui_help();
                }
                "/clear" => {
                    engine = build_engine(
                        &workspace,
                        &model,
                        &base_url,
                        api_key.as_deref(),
                        wire_api,
                        thinking.clone(),
                        approval_mode,
                        db.clone(),
                    )?;
                    println!("{GREEN}Session cleared.{RESET}\n");
                }
                "/model" => {
                    if arg.is_empty() {
                        println!("Current model: {GREEN}{model}{RESET}");
                    } else {
                        model = arg.to_string();
                        saved.model = Some(model.clone());
                        let _ = save_config(&saved);
                        let ep = resolve_model_endpoint(
                            &model,
                            None,
                            Some(&base_url),
                            api_key.as_deref(),
                        )?;
                        engine.endpoint = ep;
                        println!("Switched model -> {GREEN}{model}{RESET}");
                    }
                }
                "/wire" => {
                    if arg.is_empty() {
                        println!("Current wire: {wire_api:?}");
                    } else {
                        wire_api = WireApiMode::parse_flag(arg);
                        engine.wire_api_mode = wire_api;
                        saved.wire_api = Some(arg.to_string());
                        let _ = save_config(&saved);
                        println!("Switched wire -> {CYAN}{wire_api:?}{RESET}");
                    }
                }
                "/thinking" => {
                    thinking = if arg.is_empty() || arg.eq_ignore_ascii_case("off") {
                        None
                    } else {
                        Some(arg.to_string())
                    };
                    engine.thinking_level = thinking.clone();
                    saved.thinking = thinking.clone();
                    let _ = save_config(&saved);
                    println!(
                        "Thinking level -> {}",
                        thinking.as_deref().unwrap_or("off")
                    );
                }
                "/mode" => {
                    if let Some(m) = parse_approval(arg) {
                        approval_mode = m;
                        saved.approval_mode = Some(format_approval(m).to_string());
                        let _ = save_config(&saved);
                        engine = build_engine(
                            &workspace,
                            &model,
                            &base_url,
                            api_key.as_deref(),
                            wire_api,
                            thinking.clone(),
                            approval_mode,
                            db.clone(),
                        )?;
                        println!("Approval mode -> {YELLOW}{}{RESET}", format_approval(m));
                    } else {
                        println!("{RED}Invalid mode.{RESET} Use: yolo | write | plan | always-ask");
                    }
                }
                "/cd" => {
                    if arg.is_empty() {
                        println!("Workspace: {}", workspace.display());
                    } else {
                        let next_ws = sanitize_windows_path(Path::new(arg));
                        if !next_ws.is_dir() {
                            println!("{RED}Directory not found:{RESET} {}", next_ws.display());
                        } else {
                            workspace = next_ws;
                            engine = build_engine(
                                &workspace,
                                &model,
                                &base_url,
                                api_key.as_deref(),
                                wire_api,
                                thinking.clone(),
                                approval_mode,
                                db.clone(),
                            )?;
                            println!("{GREEN}Workspace -> {}{RESET}", workspace.display());
                        }
                    }
                }
                "/key" => {
                    if arg.is_empty() {
                        println!(
                            "API key: {}",
                            if api_key.as_deref().is_some_and(|k| !k.trim().is_empty()) {
                                "configured"
                            } else {
                                "not set"
                            }
                        );
                    } else {
                        api_key = Some(arg.to_string());
                        saved.api_key = api_key.clone();
                        save_config(&saved)?;
                        let ep = resolve_model_endpoint(
                            &model,
                            None,
                            Some(&base_url),
                            api_key.as_deref(),
                        )?;
                        engine.endpoint = ep;
                        println!("{GREEN}API key saved to {}{RESET}", config_path().display());
                    }
                }
                "/base-url" => {
                    if arg.is_empty() {
                        println!("Base URL: {base_url}");
                    } else {
                        base_url = arg.to_string();
                        saved.base_url = Some(base_url.clone());
                        save_config(&saved)?;
                        let ep = resolve_model_endpoint(
                            &model,
                            None,
                            Some(&base_url),
                            api_key.as_deref(),
                        )?;
                        engine.endpoint = ep;
                        println!("{GREEN}Base URL -> {base_url}{RESET}");
                    }
                }
                "/rewind" => {
                    let Ok(turn) = arg.parse::<u32>() else {
                        println!("{RED}Usage:{RESET} /rewind <turn_number>");
                        continue;
                    };
                    match engine.rewind_to_turn(turn) {
                        Ok(restored) => println!(
                            "{GREEN}Rewound to turn {turn}{RESET} ({} file(s) restored)",
                            restored.len()
                        ),
                        Err(e) => println!("{RED}Rewind failed:{RESET} {e:#}"),
                    }
                }
                "/status" => {
                    let cs = engine.cache_guard.snapshot();
                    let rss_mb =
                        process_tree_rss_bytes(std::process::id()) as f64 / (1024.0 * 1024.0);
                    println!(
                        "{DIM}turns={0} tool_calls={1} tool_err={2} kv_hit={3:.1}% in={4} cache_read={5} out={6} rss={7:.1}MiB{RESET}",
                        engine.total_turns,
                        engine.total_tool_calls,
                        engine.total_tool_errors,
                        cs.cache_hit_pct,
                        cs.uncached_input_tokens,
                        cs.cache_read_tokens,
                        cs.output_tokens,
                        rss_mb
                    );
                }
                _ => {
                    println!("{RED}Unknown command `{cmd}`.{RESET} Type `/help` for options.");
                }
            }
            continue;
        }

        if api_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
            println!("{RED}No API key configured.{RESET} Set `HTMUSTC_API_KEY` or run `/key <your-key>`.");
            continue;
        }

        let t0 = Instant::now();
        let streaming_state = Arc::new(Mutex::new((false, false))); // (printed_thinking, printed_text)
        let sink: HarnessEventSink = {
            let st = Arc::clone(&streaming_state);
            Arc::new(move |ev: HarnessStreamEvent| match ev {
                HarnessStreamEvent::DeltaBatch {
                    text_delta,
                    thinking_delta,
                    ..
                } => {
                    if let Ok(mut guard) = st.lock() {
                        if !thinking_delta.is_empty() {
                            if !guard.0 {
                                print!("{DIM}[thinking] ");
                                guard.0 = true;
                            }
                            print!("{thinking_delta}");
                            let _ = io::stdout().flush();
                        }
                        if !text_delta.is_empty() {
                            if guard.0 && !guard.1 {
                                println!("{RESET}");
                            }
                            if !guard.1 {
                                print!("\n{BOLD}{GREEN}Omnia ›{RESET} ");
                                guard.1 = true;
                            }
                            print!("{text_delta}");
                            let _ = io::stdout().flush();
                        }
                    }
                }
                HarnessStreamEvent::ToolStart { tool_name, .. } => {
                    if let Ok(mut guard) = st.lock() {
                        if guard.0 || guard.1 {
                            println!("{RESET}");
                            *guard = (false, false);
                        }
                    }
                    println!("{MAGENTA}  ▸ {tool_name}{RESET} {DIM}running...{RESET}");
                }
                HarnessStreamEvent::ToolEnd {
                    tool_name,
                    is_error,
                    duration_ms,
                    ..
                } => {
                    let badge = if is_error {
                        format!("{RED}err{RESET}")
                    } else {
                        format!("{GREEN}ok{RESET}")
                    };
                    println!("{DIM}  ✓ {tool_name} [{badge}{DIM}] ({duration_ms} ms){RESET}");
                }
                HarnessStreamEvent::AutoRecovery { attempt, reason } => {
                    println!(
                        "{YELLOW}  ↻ retry #{attempt}: {}{RESET}",
                        redact_secrets(&reason)
                    );
                }
                _ => {}
            })
        };

        match engine
            .run_prompt(trimmed, opts.max_turns, opts.timeout_secs, Some(sink))
            .await
        {
            Ok(summary) => {
                if let Ok(guard) = streaming_state.lock() {
                    if guard.0 || guard.1 {
                        println!("{RESET}");
                    } else if !summary.final_text.trim().is_empty() {
                        println!("\n{BOLD}{GREEN}Omnia ›{RESET} {}", summary.final_text);
                    }
                }
                let cs = engine.cache_guard.snapshot();
                let tps = if summary.active_decode_ms > 0 {
                    (cs.output_tokens as f64) / (summary.active_decode_ms as f64 / 1000.0)
                } else {
                    0.0
                };
                let rss_mb =
                    process_tree_rss_bytes(std::process::id()) as f64 / (1024.0 * 1024.0);
                println!(
                    "{DIM}  ── {:.2}s | {} turns | KV {:.1}% | {:.1} tok/s | {:.1} MiB RSS ──{RESET}\n",
                    t0.elapsed().as_secs_f64(),
                    summary.turns,
                    cs.cache_hit_pct,
                    tps,
                    rss_mb
                );
            }
            Err(e) => {
                println!(
                    "\n{RED}Error:{RESET} {}\n",
                    redact_secrets(&format!("{e:#}"))
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_mode_parser_handles_tui_aliases() {
        assert_eq!(parse_approval("yolo"), Some(ApprovalMode::Yolo));
        assert_eq!(parse_approval("write"), Some(ApprovalMode::Write));
        assert_eq!(parse_approval("plan"), Some(ApprovalMode::Plan));
        assert_eq!(parse_approval("ask"), Some(ApprovalMode::AlwaysAsk));
        assert_eq!(parse_approval("bad"), None);
    }
}
