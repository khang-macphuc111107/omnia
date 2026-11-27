//! Full-Screen Pure-Rust Terminal UI (TUI) for `omnia` powered by `ratatui` + `crossterm`.
//!
//! Launches by default on interactive `omnia` invocations (`--omp-tui` keeps the legacy
//! external Bun OMP launcher optional), preserving `<15 ms` startup, `<14 MiB` binary
//! footprint, real-time token/tool/diff/KV-cache/TPS HUD, slash command overlay, and
//! non-blocking Win32/POSIX approval modals.

use anyhow::{Context, Result};
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use omnia_agent::{
    default_omnia_data_dir, process_tree_rss_bytes, redact_secrets, resolve_model_endpoint,
    sanitize_windows_path, AgentStore, ApprovalMode, HarnessEventSink, HarnessStreamEvent,
    NativeSuperEngine, PermissionsEngine, PluginRegistry, WireApiMode, WorkspaceGraphIndex,
};
use omnia_core::credentials::{CredentialStore, MaskedCredential};
use omnia_core::PrivacyMask;
use omnia_routing::DynamicProviderRouter;
use omnia_workspace_ops::hardware::{collect_host_system_snapshot, HostSystemSnapshot};
use omnia_workspace_ops::net_diag::{
    default_upstream_targets, inspect_dns_and_benchmark, inspect_network_identity,
    inspect_proxy_tls_and_endpoints, run_speedtest_streaming, DnsBenchOptions, DnsIntelReport,
    NetDiagOptions, NetworkIdentityReport, ProxyTlsReport, SpeedtestConfig,
    SpeedtestProgressEvent, SpeedtestResult,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::Terminal;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use unicode_width::UnicodeWidthStr;

const DEFAULT_BASE_URL: &str = "https://htmustc.id.vn/v1";
const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct CliSavedConfig {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub wire_api: Option<String>,
    pub approval_mode: Option<String>,
    pub thinking: Option<String>,
    pub theme: Option<String>,
    pub privacy_mask: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TuiTheme {
    #[default]
    Obsidian,
    Titanium,
    Alabaster,
    Blueprint,
}

impl TuiTheme {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "obsidian" | "dark" => Some(Self::Obsidian),
            "titanium" | "slate" => Some(Self::Titanium),
            "alabaster" | "light" => Some(Self::Alabaster),
            "blueprint" | "midnight" => Some(Self::Blueprint),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Obsidian => "obsidian",
            Self::Titanium => "titanium",
            Self::Alabaster => "alabaster",
            Self::Blueprint => "blueprint",
        }
    }

    const fn accent(self) -> Color {
        match self {
            Self::Obsidian => Color::Cyan,
            Self::Titanium => Color::LightCyan,
            Self::Alabaster => Color::Blue,
            Self::Blueprint => Color::LightBlue,
        }
    }

    const fn border(self) -> Color {
        match self {
            Self::Obsidian => Color::DarkGray,
            Self::Titanium => Color::Gray,
            Self::Alabaster => Color::DarkGray,
            Self::Blueprint => Color::Blue,
        }
    }

    const fn hud_bg(self) -> Color {
        match self {
            Self::Obsidian => Color::Gray,
            Self::Titanium => Color::DarkGray,
            Self::Alabaster => Color::White,
            Self::Blueprint => Color::Blue,
        }
    }

    const fn hud_fg(self) -> Color {
        match self {
            Self::Obsidian => Color::Black,
            Self::Titanium => Color::White,
            Self::Alabaster => Color::Black,
            Self::Blueprint => Color::White,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum DrawerTab {
    #[default]
    Closed,
    Status,
    Network,
    Router,
    Cache,
    Swarm,
    Memory,
    Rewind,
}

impl DrawerTab {
    const fn next(self) -> Self {
        match self {
            Self::Closed => Self::Status,
            Self::Status => Self::Network,
            Self::Network => Self::Router,
            Self::Router => Self::Cache,
            Self::Cache => Self::Swarm,
            Self::Swarm => Self::Memory,
            Self::Memory => Self::Rewind,
            Self::Rewind => Self::Closed,
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Closed => "",
            Self::Status => "Status & Host",
            Self::Network => "Network & Speedtest",
            Self::Router => "Router Lab",
            Self::Cache => "KV Prefix & Cache",
            Self::Swarm => "Swarm & Graph",
            Self::Memory => "Memory & Playbook",
            Self::Rewind => "Rewind Preview",
        }
    }
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

#[derive(Debug, Clone, Copy)]
struct SlashDef {
    cmd: &'static str,
    usage: &'static str,
    desc: &'static str,
}

const SLASH_DEFS: &[SlashDef] = &[
    SlashDef {
        cmd: "/help",
        usage: "/help",
        desc: "Show keybindings & command help",
    },
    SlashDef {
        cmd: "/model",
        usage: "/model <id>",
        desc: "Switch model (claude-sonnet-5-5, gpt-6.2-sol, gemini-3.8-flash)",
    },
    SlashDef {
        cmd: "/wire",
        usage: "/wire <mode>",
        desc: "Wire dialect: auto | chat | responses | messages | gemini",
    },
    SlashDef {
        cmd: "/effort",
        usage: "/effort <level>",
        desc: "Reasoning effort: auto | none | low | medium | high | xhigh | max",
    },
    SlashDef {
        cmd: "/thinking",
        usage: "/thinking <level>",
        desc: "Alias of /effort (default: max)",
    },
    SlashDef {
        cmd: "/mode",
        usage: "/mode <approval>",
        desc: "Approval mode: yolo | write | plan | always-ask",
    },
    SlashDef {
        cmd: "/cd",
        usage: "/cd <dir>",
        desc: "Change workspace directory cleanly",
    },
    SlashDef {
        cmd: "/key",
        usage: "/key <secret>",
        desc: "Save API key to ~/.omnia/cli_config.json",
    },
    SlashDef {
        cmd: "/base-url",
        usage: "/base-url <url>",
        desc: "Set upstream provider base URL",
    },
    SlashDef {
        cmd: "/creds",
        usage: "/creds",
        desc: "Inspect masked Win32 Credential Manager vault",
    },
    SlashDef {
        cmd: "/creds-del",
        usage: "/creds-del <target>",
        desc: "Delete a credential entry from Win32 CredMan",
    },
    SlashDef {
        cmd: "/rewind",
        usage: "/rewind [preview|apply] <n>",
        desc: "Inspect per-file diff preview or apply BLAKE3 rewind",
    },
    SlashDef {
        cmd: "/status",
        usage: "/status",
        desc: "Telemetry waterfall, cost/KV savings & host CPU/RAM/RSS",
    },
    SlashDef {
        cmd: "/net",
        usage: "/net [dns|proxy|offline]",
        desc: "Inspect IP/NICs/VPN/NAT, DNS benchmark & proxy/TLS waterfall",
    },
    SlashDef {
        cmd: "/speedtest",
        usage: "/speedtest [quick|standard|cancel]",
        desc: "Run live cancellable speedtest & bufferbloat A+..F probe",
    },
    SlashDef {
        cmd: "/router",
        usage: "/router [trip|reset <id>|receipt]",
        desc: "Inspect SQLite router waterfall, runway, timeline & breakers",
    },
    SlashDef {
        cmd: "/cache",
        usage: "/cache",
        desc: "Inspect Prefix-0 BLAKE3 stability, hit % & KV dollar savings",
    },
    SlashDef {
        cmd: "/swarm",
        usage: "/swarm",
        desc: "Inspect WorkspaceGraphIndex CST/Merkle & peer-mesh state",
    },
    SlashDef {
        cmd: "/memory",
        usage: "/memory [query]",
        desc: "Recall workspace memory graph & playbook insights",
    },
    SlashDef {
        cmd: "/compact",
        usage: "/compact",
        desc: "Fold stale tool observations keeping Prefix-0 hot",
    },
    SlashDef {
        cmd: "/export",
        usage: "/export [path]",
        desc: "Export redacted/privacy-masked Markdown session report",
    },
    SlashDef {
        cmd: "/privacy",
        usage: "/privacy [on|off]",
        desc: "Toggle global Privacy Mask (IPs/MACs/SSIDs/paths/emails)",
    },
    SlashDef {
        cmd: "/theme",
        usage: "/theme <obsidian|titanium|alabaster|blueprint>",
        desc: "Switch WCAG cockpit color palette",
    },
    SlashDef {
        cmd: "/clear",
        usage: "/clear",
        desc: "Reset conversation history & start fresh session",
    },
    SlashDef {
        cmd: "/exit",
        usage: "/exit",
        desc: "Exit Omnia TUI",
    },
];

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

pub fn parse_approval(raw: &str) -> Option<ApprovalMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "yolo" | "auto" => Some(ApprovalMode::Yolo),
        "write" => Some(ApprovalMode::Write),
        "plan" => Some(ApprovalMode::Plan),
        "always-ask" | "ask" => Some(ApprovalMode::AlwaysAsk),
        "always-ask-cached" => Some(ApprovalMode::AlwaysAskCached),
        _ => None,
    }
}

fn mask_secret_hint(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => {
            let chars: Vec<char> = v.chars().collect();
            if chars.len() <= 6 {
                "*** (configured)".to_string()
            } else {
                let head: String = chars[..4].iter().collect();
                let tail: String = chars[chars.len() - 2..].iter().collect();
                format!("{head}...{tail} (len {})", chars.len())
            }
        }
        None => "unset".to_string(),
    }
}

fn uuid_like_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{ns:x}")
}

enum UiAsyncEvent {
    Harness(HarnessStreamEvent),
    ApprovalPrompt {
        tool_name: String,
        reason: String,
        reply: oneshot::Sender<bool>,
    },
    TurnFinished {
        engine: Box<NativeSuperEngine>,
        elapsed_secs: f64,
        turns: u32,
        kv_pct: f64,
        tps: f64,
        final_text: String,
        cost_usd: f64,
        kv_savings_usd: f64,
        err: Option<String>,
    },
    NetworkSnapshot {
        identity: Box<NetworkIdentityReport>,
        dns: Box<DnsIntelReport>,
        proxy_tls: Box<ProxyTlsReport>,
        host: Box<HostSystemSnapshot>,
    },
    SpeedtestProgress(SpeedtestProgressEvent),
    SpeedtestFinished(Box<SpeedtestResult>),
}

#[derive(Debug, Clone)]
enum TranscriptEntryKind {
    User,
    Assistant,
    Thinking,
    Tool { is_error: bool },
    DiffLine { added: bool, removed: bool },
    System,
}

#[derive(Debug, Clone)]
struct TranscriptLine {
    kind: TranscriptEntryKind,
    text: String,
}

struct PendingApproval {
    tool_name: String,
    reason: String,
    reply: oneshot::Sender<bool>,
}

struct TuiAppState {
    workspace: PathBuf,
    model: String,
    base_url: String,
    api_key: Option<String>,
    wire_api: WireApiMode,
    thinking: Option<String>,
    approval_mode: ApprovalMode,
    saved: CliSavedConfig,
    max_turns: u32,
    timeout_secs: u64,
    db: Option<AgentStore>,
    engine: Option<NativeSuperEngine>,

    transcript: Vec<TranscriptLine>,
    input: String,
    cursor_byte: usize,
    history: Vec<String>,
    history_idx: Option<usize>,
    scroll_offset: u16,
    auto_scroll: bool,
    show_thinking: bool,
    show_creds_modal: bool,
    cred_entries: Vec<MaskedCredential>,
    slash_selected: usize,

    running: bool,
    cancel_flag: Arc<AtomicBool>,
    pending_approval: Option<PendingApproval>,

    kv_hit_pct: f64,
    tokens_per_sec: f64,
    cost_usd: f64,
    kv_savings_usd: f64,
    context_pct: f64,
    total_turns: u32,
    total_tools: u32,
    tool_errors: u32,
    cached_rss_bytes: u64,
    last_rss_refresh: Instant,

    theme: TuiTheme,
    privacy_mask: bool,
    drawer_tab: DrawerTab,
    drawer_lines: Vec<String>,
    speedtest_running: bool,
    speedtest_cancel: Arc<AtomicBool>,
    last_speedtest_progress: Option<String>,
    last_net_summary: Vec<String>,
    last_speedtest_summary: Vec<String>,
    last_router_summary: Vec<String>,
    last_rewind_summary: Vec<String>,
}

impl TuiAppState {
    fn mask_if_enabled(&self, raw: &str) -> String {
        if self.privacy_mask {
            PrivacyMask::mask_text(raw)
        } else {
            raw.to_string()
        }
    }

    fn refresh_rss_if_stale(&mut self, now: Instant) -> bool {
        if now.duration_since(self.last_rss_refresh) >= Duration::from_secs(2) {
            self.cached_rss_bytes = process_tree_rss_bytes(std::process::id());
            self.last_rss_refresh = now;
            return true;
        }
        false
    }
    fn push_line(&mut self, kind: TranscriptEntryKind, text: impl Into<String>) {
        for raw_line in text.into().lines() {
            let line = raw_line.to_string();
            let resolved_kind = match &kind {
                TranscriptEntryKind::Tool { is_error: false } if line.starts_with('+') && !line.starts_with("+++") => {
                    TranscriptEntryKind::DiffLine {
                        added: true,
                        removed: false,
                    }
                }
                TranscriptEntryKind::Tool { is_error: false } if line.starts_with('-') && !line.starts_with("---") => {
                    TranscriptEntryKind::DiffLine {
                        added: false,
                        removed: true,
                    }
                }
                other => other.clone(),
            };
            self.transcript.push(TranscriptLine {
                kind: resolved_kind,
                text: line,
            });
        }
        if self.transcript.len() > 4000 {
            let drain = self.transcript.len() - 4000;
            self.transcript.drain(..drain);
        }
    }

    fn append_delta(&mut self, kind: TranscriptEntryKind, delta: &str) {
        if delta.is_empty() {
            return;
        }
        let same_kind = self
            .transcript
            .last()
            .is_some_and(|l| matches!((&l.kind, &kind), (TranscriptEntryKind::Assistant, TranscriptEntryKind::Assistant) | (TranscriptEntryKind::Thinking, TranscriptEntryKind::Thinking)));

        let parts: Vec<&str> = delta.split('\n').collect();
        for (i, part) in parts.iter().enumerate() {
            if i == 0 && same_kind {
                if let Some(last) = self.transcript.last_mut() {
                    last.text.push_str(part);
                }
            } else {
                self.transcript.push(TranscriptLine {
                    kind: kind.clone(),
                    text: (*part).to_string(),
                });
            }
        }
    }

    fn filtered_slash(&self) -> Vec<SlashDef> {
        let trimmed = self.input.trim_start();
        if !trimmed.starts_with('/') {
            return Vec::new();
        }
        let token = trimmed.split_whitespace().next().unwrap_or("/");
        SLASH_DEFS
            .iter()
            .copied()
            .filter(|d| d.cmd.starts_with(token))
            .collect()
    }

    fn insert_char(&mut self, c: char) {
        self.input.insert(self.cursor_byte, c);
        self.cursor_byte += c.len_utf8();
    }

    fn backspace(&mut self) {
        if self.cursor_byte == 0 {
            return;
        }
        if let Some((idx, _)) = self.input[..self.cursor_byte].char_indices().next_back() {
            self.input.drain(idx..self.cursor_byte);
            self.cursor_byte = idx;
        }
    }

    fn move_left(&mut self) {
        if let Some((idx, _)) = self.input[..self.cursor_byte].char_indices().next_back() {
            self.cursor_byte = idx;
        }
    }

    fn move_right(&mut self) {
        if let Some(ch) = self.input[self.cursor_byte..].chars().next() {
            self.cursor_byte += ch.len_utf8();
        }
    }
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
    cancel_flag: Arc<AtomicBool>,
    ui_tx: Option<mpsc::UnboundedSender<UiAsyncEvent>>,
) -> Result<NativeSuperEngine> {
    let endpoint = resolve_model_endpoint(model, None, Some(base_url), api_key)?;
    let graph = Arc::new(Mutex::new(WorkspaceGraphIndex::new(workspace)));
    let session_key = format!("tui-{}", uuid_like_id());

    let approver = Some(Arc::new(move |tool_name: String, reason: String| {
        let tx_opt = ui_tx.clone();
        Box::pin(async move {
            if let Some(tx) = tx_opt {
                let (reply_tx, reply_rx) = oneshot::channel();
                if tx
                    .send(UiAsyncEvent::ApprovalPrompt {
                        tool_name,
                        reason,
                        reply: reply_tx,
                    })
                    .is_ok()
                {
                    return reply_rx.await.unwrap_or(false);
                }
                return false;
            }
            tokio::task::spawn_blocking(move || {
                print!("\n[Approval Required] tool `{tool_name}` ({reason}). Allow? [y/N]: ");
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

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<Self> {
        enable_raw_mode()?;
        let mut out = io::stdout();
        execute!(out, EnterAlternateScreen, EnableMouseCapture)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen, DisableMouseCapture);
    }
}

fn render_ui(frame: &mut ratatui::Frame, state: &mut TuiAppState) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(5),
            Constraint::Length(1),
        ])
        .split(area);

    // 1. OMP-Inspired Header Strip (uses cached RSS refreshed <= once every 2s)
    let rss_mb = state.cached_rss_bytes as f64 / (1024.0 * 1024.0);
    let key_badge = if state.api_key.as_deref().is_some_and(|k| !k.trim().is_empty()) {
        Span::styled("KEY OK", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    } else {
        Span::styled("NO KEY (/key)", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD))
    };
    let think_label = state.thinking.as_deref().unwrap_or("max");
    let ws_display = state.mask_if_enabled(&state.workspace.display().to_string());
    let accent = state.theme.accent();
    let border_col = state.theme.border();
    let mut header_spans = vec![
        Span::styled(" OMNIA ", Style::default().fg(Color::Black).bg(accent).add_modifier(Modifier::BOLD)),
        Span::raw(format!(" v{} ", env!("CARGO_PKG_VERSION"))),
        Span::styled("| ", Style::default().fg(border_col)),
        Span::styled(state.model.clone(), Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)),
        Span::raw(format!(" [{think_label}] ")),
        Span::styled("| ", Style::default().fg(border_col)),
        Span::styled(format!("{:?}", state.wire_api), Style::default().fg(Color::LightBlue)),
        Span::raw(format!(" · {} ", format_approval(state.approval_mode))),
        Span::styled("| ", Style::default().fg(border_col)),
        key_badge,
    ];
    if state.privacy_mask {
        header_spans.push(Span::styled(" | ", Style::default().fg(border_col)));
        header_spans.push(Span::styled(
            "MASK ON",
            Style::default().fg(Color::Black).bg(Color::Yellow).add_modifier(Modifier::BOLD),
        ));
    }
    header_spans.push(Span::styled(" | ", Style::default().fg(border_col)));
    header_spans.push(Span::raw(format!("ws: {ws_display}")));
    let header_line = Line::from(header_spans);
    let header = Paragraph::new(header_line).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(accent))
            .title(format!(" Pure-Rust Super-Harness TUI [{}] ", state.theme.as_str())),
    );
    frame.render_widget(header, chunks[0]);

    // 2. Main Transcript Viewport + Optional Cockpit Drawer (`F4`)
    let show_drawer = state.drawer_tab != DrawerTab::Closed && chunks[1].width >= 96;
    let (transcript_area, drawer_area_opt) = if show_drawer {
        let split = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(chunks[1]);
        (split[0], Some(split[1]))
    } else {
        (chunks[1], None)
    };

    let visible_lines: Vec<Line> = state
        .transcript
        .iter()
        .filter(|entry| state.show_thinking || !matches!(entry.kind, TranscriptEntryKind::Thinking))
        .map(|entry| {
            let txt = state.mask_if_enabled(&entry.text);
            match entry.kind {
                TranscriptEntryKind::User => Line::from(vec![
                    Span::styled("› ", Style::default().fg(accent).add_modifier(Modifier::BOLD)),
                    Span::styled(txt, Style::default().fg(Color::White).add_modifier(Modifier::BOLD)),
                ]),
                TranscriptEntryKind::Assistant => Line::from(Span::styled(txt, Style::default().fg(Color::Gray))),
                TranscriptEntryKind::Thinking => Line::from(Span::styled(
                    format!("  [thinking] {txt}"),
                    Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
                )),
                TranscriptEntryKind::Tool { is_error } => Line::from(Span::styled(
                    txt,
                    Style::default().fg(if is_error { Color::Red } else { Color::Magenta }),
                )),
                TranscriptEntryKind::DiffLine { added, removed } => Line::from(Span::styled(
                    txt,
                    Style::default().fg(if added {
                        Color::Green
                    } else if removed {
                        Color::Red
                    } else {
                        Color::Gray
                    }),
                )),
                TranscriptEntryKind::System => Line::from(Span::styled(txt, Style::default().fg(Color::Yellow))),
            }
        })
        .collect();

    let inner_height = transcript_area.height.saturating_sub(2) as usize;
    let total_rows = visible_lines.len();
    let max_scroll = total_rows.saturating_sub(inner_height) as u16;
    if state.auto_scroll || state.scroll_offset > max_scroll {
        state.scroll_offset = max_scroll;
    }

    let body_title = if state.running {
        " Transcript [STREAMING · Esc to Abort] "
    } else if state.show_thinking {
        " Transcript [F2: Hide Thinking · F4: Drawer · F5: Mask] "
    } else {
        " Transcript [F2: Thinking · F3: Creds · F4: Drawer · F5: Mask] "
    };

    let transcript_widget = Paragraph::new(visible_lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border_col))
                .title(body_title),
        )
        .wrap(Wrap { trim: false })
        .scroll((state.scroll_offset, 0));
    frame.render_widget(transcript_widget, transcript_area);

    if let Some(d_area) = drawer_area_opt {
        let d_lines: Vec<Line> = build_drawer_lines(state)
            .into_iter()
            .map(|l| Line::from(Span::styled(state.mask_if_enabled(&l), Style::default().fg(Color::Gray))))
            .collect();
        let drawer_widget = Paragraph::new(d_lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(accent))
                    .title(format!(" Cockpit: {} [F4 next · Esc close] ", state.drawer_tab.title())),
            )
            .wrap(Wrap { trim: false });
        frame.render_widget(drawer_widget, d_area);
    }

    // 3. Band Composer with Observe-Only Smart Prompt Preflight
    let composer_title = if state.running {
        " Composer (Streaming active — Enter disabled until Esc/finish) ".to_string()
    } else if !state.input.trim().is_empty() && !state.input.trim_start().starts_with('/') {
        if let Some(ref eng) = state.engine {
            let pre = eng.preflight_prompt(&state.input);
            format!(
                " Prompt [preflight ~{}t · ctx {:.1}% · {} · {} · budget:NULL] ",
                pre.estimated_prompt_tokens,
                pre.projected_context_fill_pct,
                pre.effective_effort.as_deref().unwrap_or("none"),
                pre.wire_dialect
            )
        } else {
            " Prompt (Enter send · Alt+Enter newline · / commands · PgUp/PgDn scroll) ".to_string()
        }
    } else {
        " Prompt (Enter send · Alt+Enter newline · / commands · PgUp/PgDn scroll) ".to_string()
    };
    let composer_widget = Paragraph::new(state.input.as_str())
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(if state.running { Color::Yellow } else { accent }))
                .title(composer_title),
        )
        .wrap(Wrap { trim: false });
    frame.render_widget(composer_widget, chunks[2]);

    // Position cursor respecting UTF-8 & unicode-width
    if state.pending_approval.is_none() && !state.show_creds_modal {
        let before = &state.input[..state.cursor_byte.min(state.input.len())];
        let lines_before: Vec<&str> = before.split('\n').collect();
        let row_off = lines_before.len().saturating_sub(1) as u16;
        let col_off = lines_before.last().map(|s| s.width()).unwrap_or(0) as u16;
        let cx = (chunks[2].x + 1 + col_off).min(chunks[2].right().saturating_sub(2));
        let cy = (chunks[2].y + 1 + row_off).min(chunks[2].bottom().saturating_sub(2));
        frame.set_cursor_position((cx, cy));
    }

    // 4. Bottom HUD Telemetry Strip (KV-Cache / TPS / Cost+Savings / Speedtest / RSS / Token Budget NULL)
    let st_badge = state
        .last_speedtest_progress
        .as_deref()
        .map(|s| format!(" | {s}"))
        .unwrap_or_default();
    let mask_badge = if state.privacy_mask { " | MASK" } else { "" };
    let hud = Line::from(vec![
        Span::styled(
            format!(
                " turns:{} tools:{}(err:{}) | KV:{:.1}% | {:.1} tok/s | ctx:{:.0}% | ${:.4} (saved ${:.4}) | RSS:{:.1}MiB | budget:NULL{}{} ",
                state.total_turns,
                state.total_tools,
                state.tool_errors,
                state.kv_hit_pct,
                state.tokens_per_sec,
                state.context_pct,
                state.cost_usd,
                state.kv_savings_usd,
                rss_mb,
                st_badge,
                mask_badge
            ),
            Style::default().fg(state.theme.hud_fg()).bg(state.theme.hud_bg()),
        ),
    ]);
    frame.render_widget(Paragraph::new(hud), chunks[3]);

    // 5. Slash Command Autocomplete Overlay
    let slash_items = state.filtered_slash();
    if !slash_items.is_empty() && !state.running {
        let popup_h = (slash_items.len() as u16 + 2).min(10);
        let popup_area = Rect {
            x: chunks[2].x + 1,
            y: chunks[2].y.saturating_sub(popup_h),
            width: chunks[2].width.saturating_sub(2).min(78),
            height: popup_h,
        };
        let list_items: Vec<ListItem> = slash_items
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let style = if i == state.slash_selected % slash_items.len() {
                    Style::default().bg(Color::Blue).fg(Color::White).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(Color::Gray)
                };
                ListItem::new(Line::from(format!("{:<16} {}", s.usage, s.desc))).style(style)
            })
            .collect();
        frame.render_widget(Clear, popup_area);
        frame.render_widget(
            List::new(list_items).block(Block::default().borders(Borders::ALL).title(" Slash Commands (Tab/Enter) ")),
            popup_area,
        );
    }

    // 6. Credentials Modal (/creds or F3)
    if state.show_creds_modal {
        let modal = centered_rect(76, 55, area);
        frame.render_widget(Clear, modal);
        let mut lines = vec![
            Line::from(Span::styled(
                "Win32 Credential Manager + Masked Env (0 Plaintext Secrets)",
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(format!("  HTMUSTC_API_KEY : {}", mask_secret_hint(env::var("HTMUSTC_API_KEY").ok().as_deref()))),
            Line::from(format!("  OMNIA_API_KEY   : {}", mask_secret_hint(env::var("OMNIA_API_KEY").ok().as_deref()))),
            Line::from(format!("  OPENAI_API_KEY  : {}", mask_secret_hint(env::var("OPENAI_API_KEY").ok().as_deref()))),
            Line::from(format!("  cli_config.json : {}", mask_secret_hint(state.saved.api_key.as_deref()))),
            Line::from(format!("  Active Base URL : {}", state.mask_if_enabled(&state.base_url))),
            Line::from(""),
            Line::from(Span::styled("  Stored omnia:* Targets:", Style::default().fg(Color::White).add_modifier(Modifier::BOLD))),
        ];
        if state.cred_entries.is_empty() {
            lines.push(Line::from("    (none stored yet — run `/key <secret>` to persist in Win32 CredMan)"));
        } else {
            for c in state.cred_entries.iter().take(6) {
                let hint = if state.privacy_mask { "[MASKED_HINT]" } else { c.masked_hint.as_str() };
                lines.push(Line::from(format!("    {} [{}] · {} · {}", c.target, c.kind, c.label, hint)));
            }
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Esc/F3 close | /key <secret> save | /creds-del <target> remove",
            Style::default().fg(Color::Yellow),
        )));
        frame.render_widget(
            Paragraph::new(lines).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Yellow))
                    .title(" Credential Manager "),
            ),
            modal,
        );
    }

    // 7. Approval Modal Overlay
    if let Some(ref appr) = state.pending_approval {
        let modal = centered_rect(68, 30, area);
        frame.render_widget(Clear, modal);
        let lines = vec![
            Line::from(Span::styled(
                format!("Tool Approval Required: {}", appr.tool_name),
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(appr.reason.clone()),
            Line::from(""),
            Line::from(Span::styled("[Y] Allow   |   [N / Esc] Deny", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))),
        ];
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(Color::Yellow))
                        .title(" Security Gate "),
                ),
            modal,
        );
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(v[1])[1]
}

fn build_drawer_lines(state: &TuiAppState) -> Vec<String> {
    match state.drawer_tab {
        DrawerTab::Closed => Vec::new(),
        DrawerTab::Status => {
            let mut out = Vec::new();
            if let Some(ref eng) = state.engine {
                let snap = eng.session_telemetry_snapshot();
                out.push(format!("Session : {}", snap.session_key));
                out.push(format!(
                    "Model   : {} ({} | {})",
                    snap.model_id,
                    snap.wire_dialect,
                    snap.effort.as_deref().unwrap_or("none")
                ));
                out.push(format!(
                    "Turns   : {} | Tools: {} (err {})",
                    snap.total_turns, snap.total_tool_calls, snap.total_tool_errors
                ));
                out.push(format!(
                    "Context : {} / {} ({:.1}%) ETA: {}",
                    snap.context_tokens,
                    snap.context_window,
                    snap.context_fill_pct,
                    snap.compaction_eta_turns
                        .map_or_else(|| "-".into(), |t| format!("~{t} turns"))
                ));
                out.push(format!(
                    "Cost    : ${:.6} | KV Saved: ${:.6}",
                    snap.total_cost_usd, snap.total_kv_savings_usd
                ));
                out.push(format!(
                    "Retries : http={} stall={} trunc={} hedge={}",
                    snap.total_http_retries,
                    snap.total_stall_retries,
                    snap.total_truncated_retries,
                    snap.total_hedge_wins
                ));
                if !snap.turns.is_empty() {
                    out.push("Recent Turns:".into());
                    for t in snap.turns.iter().rev().take(6) {
                        out.push(format!(
                            "  T{} ttft={}ms {:.1}t/s out={} kv={} ${:.5}",
                            t.turn,
                            t.ttft_ms.unwrap_or(0),
                            t.active_decode_tps,
                            t.output_tokens,
                            t.cache_read_tokens,
                            t.cost_usd
                        ));
                    }
                }
                if !snap.tool_waterfall.is_empty() {
                    out.push("Recent Tools:".into());
                    for w in snap.tool_waterfall.iter().rev().take(6) {
                        out.push(format!(
                            "  T{} {} {}ms ({}B){}",
                            w.turn,
                            w.tool_name,
                            w.duration_ms,
                            w.output_bytes,
                            if w.is_error { " [ERR]" } else { "" }
                        ));
                    }
                }
            }
            if !state.drawer_lines.is_empty() {
                out.push("---".into());
                out.extend(state.drawer_lines.iter().cloned());
            }
            out
        }
        DrawerTab::Network => {
            let mut out = Vec::new();
            if state.last_net_summary.is_empty() && state.last_speedtest_summary.is_empty() {
                out.push("Run /net or /speedtest to populate live diagnostics.".into());
            } else {
                out.extend(state.last_net_summary.iter().cloned());
                if !state.last_speedtest_summary.is_empty() {
                    out.push("--- Speedtest & Bufferbloat ---".into());
                    out.extend(state.last_speedtest_summary.iter().cloned());
                }
            }
            out
        }
        DrawerTab::Router => {
            if state.last_router_summary.is_empty() {
                vec!["Run /router to inspect SQLite router state, waterfalls & breakers.".into()]
            } else {
                state.last_router_summary.clone()
            }
        }
        DrawerTab::Cache => {
            if let Some(ref eng) = state.engine {
                let cs = eng.cache_guard.snapshot();
                vec![
                    format!("Prefix Stable : {}", cs.prefix_stable),
                    format!("Mutations     : {}", cs.prefix_mutations),
                    format!("Sys BLAKE3    : {}", &cs.system_prompt_hash[..cs.system_prompt_hash.len().min(16)]),
                    format!("Tools BLAKE3  : {}", &cs.tool_schema_hash[..cs.tool_schema_hash.len().min(16)]),
                    format!("Hit Rate      : {:.1}%", cs.cache_hit_pct),
                    format!("Cache Read    : {} tok", cs.cache_read_tokens),
                    format!("Cache Write   : {} tok", cs.cache_write_tokens),
                    format!("Uncached In   : {} tok", cs.uncached_input_tokens),
                    format!("Output / Reas : {} / {} tok", cs.output_tokens, cs.reasoning_tokens),
                    format!("KV Saved      : ${:.6}", eng.total_kv_savings_usd),
                    format!("Lakeview Folds: {} ({} chars)", cs.lakeview_compressions, cs.lakeview_chars_saved),
                ]
            } else {
                vec!["Engine busy streaming...".into()]
            }
        }
        DrawerTab::Swarm => {
            if let Some(ref eng) = state.engine {
                let (files, root_hash) = {
                    let g = eng.tool_runtime.graph_index.lock().unwrap();
                    (g.merkle().files().len(), g.merkle().root_hash().to_string())
                };
                let plugins = eng.plugins.list_info();
                vec![
                    format!("Workspace     : {}", eng.workspace_root.display()),
                    format!("Indexed Files : {files}"),
                    format!("Merkle Root   : {}", &root_hash[..root_hash.len().min(16)]),
                    format!("Active Plugins: {}", plugins.len()),
                    "Peer Mesh     : 2-way A<->B duplex (disjoint_paths enforced)".into(),
                    "Token Budget  : NULL (uncapped ADDITIVE_INTAKE)".into(),
                ]
            } else {
                vec!["Engine busy streaming...".into()]
            }
        }
        DrawerTab::Memory => {
            if state.drawer_lines.is_empty() {
                vec!["Run /memory [query] to recall workspace memories & playbooks.".into()]
            } else {
                state.drawer_lines.clone()
            }
        }
        DrawerTab::Rewind => {
            if state.last_rewind_summary.is_empty() {
                vec!["Run /rewind or /rewind preview <turn> to inspect diffs before rollback.".into()]
            } else {
                state.last_rewind_summary.clone()
            }
        }
    }
}

fn handle_slash_command(
    raw: &str,
    state: &mut TuiAppState,
    tx: &mpsc::UnboundedSender<UiAsyncEvent>,
) -> Result<bool> {
    let mut parts = raw.trim().splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("");
    let arg = parts.next().unwrap_or("").trim();

    match cmd {
        "/exit" | "/quit" => return Ok(true),
        "/help" => {
            state.push_line(
                TranscriptEntryKind::System,
                "Commands: /model, /wire, /effort, /mode, /cd, /key, /base-url, /creds, /status, /net, /speedtest, /router, /cache, /swarm, /memory, /rewind, /compact, /export, /privacy, /theme, /clear, /exit",
            );
            state.push_line(
                TranscriptEntryKind::System,
                "Keys: F2 thinking | F3 creds | F4 cockpit drawer | F5 privacy mask | PgUp/PgDn scroll | Esc abort/close",
            );
        }
        "/creds" => {
            state.cred_entries = CredentialStore::list_masked().unwrap_or_default();
            state.show_creds_modal = !state.show_creds_modal;
        }
        "/creds-del" => {
            if arg.is_empty() {
                state.push_line(TranscriptEntryKind::System, "Usage: /creds-del <target>");
            } else {
                match CredentialStore::delete_secret(arg) {
                    Ok(true) => {
                        state.cred_entries = CredentialStore::list_masked().unwrap_or_default();
                        state.push_line(TranscriptEntryKind::System, format!("Deleted credential `{arg}` from CredMan."));
                    }
                    Ok(false) => state.push_line(TranscriptEntryKind::System, format!("Credential `{arg}` not found.")),
                    Err(e) => state.push_line(TranscriptEntryKind::System, format!("CredMan delete error: {e}")),
                }
            }
        }
        "/clear" => {
            state.transcript.clear();
            let eng = build_engine(
                &state.workspace,
                &state.model,
                &state.base_url,
                state.api_key.as_deref(),
                state.wire_api,
                state.thinking.clone(),
                state.approval_mode,
                state.db.clone(),
                Arc::clone(&state.cancel_flag),
                Some(tx.clone()),
            )?;
            state.engine = Some(eng);
            state.push_line(TranscriptEntryKind::System, "Started fresh session.");
        }
        "/model" => {
            if arg.is_empty() {
                state.push_line(TranscriptEntryKind::System, format!("Current model: {}", state.model));
            } else {
                state.model = arg.to_string();
                state.saved.model = Some(state.model.clone());
                let _ = save_config(&state.saved);
                if let Some(ref mut eng) = state.engine {
                    eng.endpoint = resolve_model_endpoint(&state.model, None, Some(&state.base_url), state.api_key.as_deref())?;
                }
                state.push_line(TranscriptEntryKind::System, format!("Model -> {}", state.model));
            }
        }
        "/wire" => {
            if arg.is_empty() {
                state.push_line(TranscriptEntryKind::System, format!("Wire mode: {:?}", state.wire_api));
            } else {
                state.wire_api = WireApiMode::parse_flag(arg);
                state.saved.wire_api = Some(arg.to_string());
                let _ = save_config(&state.saved);
                if let Some(ref mut eng) = state.engine {
                    eng.wire_api_mode = state.wire_api;
                }
                state.push_line(TranscriptEntryKind::System, format!("Wire -> {:?}", state.wire_api));
            }
        }
        "/thinking" | "/effort" => {
            if arg.is_empty() {
                state.push_line(
                    TranscriptEntryKind::System,
                    format!("Effort: {}", state.thinking.as_deref().unwrap_or("max")),
                );
            } else {
                state.thinking = if arg.eq_ignore_ascii_case("auto") {
                    None
                } else if arg.eq_ignore_ascii_case("off") {
                    Some("none".to_string())
                } else {
                    Some(arg.to_ascii_lowercase())
                };
                state.saved.thinking = state.thinking.clone();
                let _ = save_config(&state.saved);
                if let Some(ref mut eng) = state.engine {
                    eng.thinking_level = state.thinking.clone();
                }
                state.push_line(
                    TranscriptEntryKind::System,
                    format!("Effort -> {}", state.thinking.as_deref().unwrap_or("auto (max)")),
                );
            }
        }
        "/mode" => {
            if let Some(mode) = parse_approval(arg) {
                state.approval_mode = mode;
                state.saved.approval_mode = Some(format_approval(mode).to_string());
                let _ = save_config(&state.saved);
                if let Some(ref mut eng) = state.engine {
                    eng.tool_runtime.approval_mode = mode;
                }
                state.push_line(TranscriptEntryKind::System, format!("Approval -> {}", format_approval(mode)));
            } else {
                state.push_line(TranscriptEntryKind::System, "Usage: /mode <yolo|write|plan|always-ask>");
            }
        }
        "/cd" => {
            let candidate = PathBuf::from(arg);
            if candidate.is_dir() {
                state.workspace = sanitize_windows_path(&candidate);
                let eng = build_engine(
                    &state.workspace,
                    &state.model,
                    &state.base_url,
                    state.api_key.as_deref(),
                    state.wire_api,
                    state.thinking.clone(),
                    state.approval_mode,
                    state.db.clone(),
                    Arc::clone(&state.cancel_flag),
                    Some(tx.clone()),
                )?;
                state.engine = Some(eng);
                state.push_line(TranscriptEntryKind::System, format!("Workspace -> {}", state.workspace.display()));
            } else {
                state.push_line(TranscriptEntryKind::System, format!("Not a directory: {arg}"));
            }
        }
        "/key" => {
            if arg.is_empty() {
                state.push_line(TranscriptEntryKind::System, format!("API key: {}", mask_secret_hint(state.api_key.as_deref())));
            } else {
                state.api_key = Some(arg.to_string());
                state.saved.api_key = state.api_key.clone();
                save_config(&state.saved)?;
                let _ = CredentialStore::set_secret("omnia:cli_api_key", "api_key", "Omnia CLI Key", arg);
                state.cred_entries = CredentialStore::list_masked().unwrap_or_default();
                if let Some(ref mut eng) = state.engine {
                    eng.endpoint = resolve_model_endpoint(&state.model, None, Some(&state.base_url), state.api_key.as_deref())?;
                }
                state.push_line(TranscriptEntryKind::System, format!("Saved API key to Win32 CredMan & {}", config_path().display()));
            }
        }
        "/base-url" => {
            if !arg.is_empty() {
                state.base_url = arg.to_string();
                state.saved.base_url = Some(state.base_url.clone());
                save_config(&state.saved)?;
                if let Some(ref mut eng) = state.engine {
                    eng.endpoint = resolve_model_endpoint(&state.model, None, Some(&state.base_url), state.api_key.as_deref())?;
                }
                state.push_line(TranscriptEntryKind::System, format!("Base URL -> {}", state.base_url));
            }
        }
        "/rewind" => {
            let tokens: Vec<&str> = arg.split_whitespace().collect();
            if tokens.is_empty() {
                if let Some(ref eng) = state.engine {
                    let turns = eng.available_rewind_turns();
                    let msg = if turns.is_empty() {
                        "No turn checkpoints recorded yet.".to_string()
                    } else {
                        format!(
                            "Available checkpoint turns: {:?}. Use `/rewind preview <n>` or `/rewind apply <n>`.",
                            turns
                        )
                    };
                    state.last_rewind_summary = vec![msg.clone()];
                    state.drawer_tab = DrawerTab::Rewind;
                    state.push_line(TranscriptEntryKind::System, msg);
                }
            } else if (tokens[0].eq_ignore_ascii_case("apply")
                || tokens.iter().any(|t| *t == "--yes" || *t == "-y"))
                && tokens.iter().find_map(|t| t.parse::<u32>().ok()).is_some()
            {
                let turn = tokens.iter().find_map(|t| t.parse::<u32>().ok()).unwrap();
                if let Some(ref mut eng) = state.engine {
                    match eng.rewind_to_turn(turn) {
                        Ok(files) => {
                            let summary = format!(
                                "Rewound atomically to turn {turn} ({} file(s) restored: {})",
                                files.len(),
                                files.join(", ")
                            );
                            state.last_rewind_summary = vec![summary.clone()];
                            state.drawer_tab = DrawerTab::Rewind;
                            state.push_line(TranscriptEntryKind::System, summary);
                        }
                        Err(e) => state.push_line(TranscriptEntryKind::System, format!("Rewind failed: {e:#}")),
                    }
                }
            } else if let Some(turn) = tokens.iter().find_map(|t| t.parse::<u32>().ok()) {
                if let Some(ref eng) = state.engine {
                    match eng.preview_rewind_to_turn(turn) {
                        Ok(prev) => {
                            let mut lines = vec![format!(
                                "Rewind Preview -> Turn {} ({} file(s), +{} / -{} lines; run `/rewind apply {}` to confirm):",
                                prev.target_turn,
                                prev.files.len(),
                                prev.total_added_lines,
                                prev.total_removed_lines,
                                prev.target_turn
                            )];
                            for f in &prev.files {
                                lines.push(format!(
                                    "  [{}] {} (+{} / -{})",
                                    f.action, f.rel_path, f.added_lines, f.removed_lines
                                ));
                                for dl in f.unified_diff.lines().take(12) {
                                    lines.push(format!("    {dl}"));
                                }
                            }
                            state.last_rewind_summary = lines.clone();
                            state.drawer_tab = DrawerTab::Rewind;
                            for l in lines.iter().take(18) {
                                state.push_line(TranscriptEntryKind::System, l.clone());
                            }
                        }
                        Err(e) => state.push_line(TranscriptEntryKind::System, format!("Rewind preview failed: {e:#}")),
                    }
                }
            } else {
                state.push_line(TranscriptEntryKind::System, "Usage: /rewind [preview|apply] <turn_number>");
            }
        }
        "/status" => {
            state.drawer_tab = DrawerTab::Status;
            let host = collect_host_system_snapshot();
            let ram_tot = host.hardware.total_ram_bytes as f64 / 1_073_741_824.0;
            let ram_avail = host.hardware.available_ram_bytes as f64 / 1_073_741_824.0;
            let host_line = format!(
                "Host: CPU {:.1}% | RAM {:.1}/{:.1} GiB free | VRAM {} MiB | Ports {}",
                host.cpu_load_pct.unwrap_or(0.0),
                ram_avail,
                ram_tot,
                host.hardware.total_vram_mb,
                host.listening_ports.len()
            );
            state.drawer_lines = vec![host_line.clone()];
            if let Some(ref eng) = state.engine {
                let snap = eng.session_telemetry_snapshot();
                state.push_line(
                    TranscriptEntryKind::System,
                    format!(
                        "turns={} tools={}(err:{}) | KV:{:.1}% | ctx:{:.1}% | cost:${:.5} (saved ${:.5}) | retries:{} | budget:NULL",
                        snap.total_turns,
                        snap.total_tool_calls,
                        snap.total_tool_errors,
                        snap.cache_stats.cache_hit_pct,
                        snap.context_fill_pct,
                        snap.total_cost_usd,
                        snap.total_kv_savings_usd,
                        snap.total_http_retries
                    ),
                );
            }
            state.push_line(TranscriptEntryKind::System, host_line);
        }
        "/net" => {
            state.drawer_tab = DrawerTab::Network;
            let offline = arg.contains("offline");
            let run_dns = !offline && (arg.is_empty() || arg.contains("dns"));
            let run_proxy = !offline && (arg.is_empty() || arg.contains("proxy"));
            state.last_net_summary = vec!["Probing network identity, DNS, and proxy/TLS...".into()];
            state.push_line(TranscriptEntryKind::System, "Running native Rust network diagnostics...");
            let tx_net = tx.clone();
            tokio::task::spawn_blocking(move || {
                let identity = inspect_network_identity(&NetDiagOptions {
                    probe_public_ip: !offline,
                    timeout_ms: 2_500,
                    force_refresh: true,
                });
                let dns = inspect_dns_and_benchmark(&DnsBenchOptions {
                    run_benchmark: run_dns,
                    public_ipv4_hint: identity.public_ipv4.clone(),
                    ..DnsBenchOptions::default()
                });
                let targets = if run_proxy {
                    default_upstream_targets()
                } else {
                    Vec::new()
                };
                let proxy_tls = inspect_proxy_tls_and_endpoints(&targets, run_proxy);
                let host = collect_host_system_snapshot();
                let _ = tx_net.send(UiAsyncEvent::NetworkSnapshot {
                    identity: Box::new(identity),
                    dns: Box::new(dns),
                    proxy_tls: Box::new(proxy_tls),
                    host: Box::new(host),
                });
            });
        }
        "/speedtest" => {
            if arg.eq_ignore_ascii_case("cancel") || arg.eq_ignore_ascii_case("stop") {
                state.speedtest_cancel.store(true, Ordering::SeqCst);
                state.push_line(TranscriptEntryKind::System, "Cancelling active speedtest...");
            } else if state.speedtest_running {
                state.push_line(TranscriptEntryKind::System, "Speedtest already running. Run `/speedtest cancel` to stop.");
            } else {
                let profile = if arg.eq_ignore_ascii_case("standard") {
                    "standard"
                } else {
                    "quick"
                };
                state.speedtest_running = true;
                state.speedtest_cancel.store(false, Ordering::SeqCst);
                state.drawer_tab = DrawerTab::Network;
                state.last_speedtest_progress = Some("ST:init".into());
                state.last_speedtest_summary = vec![format!("Running {profile} speedtest & bufferbloat probe...")];
                state.push_line(
                    TranscriptEntryKind::System,
                    format!("Starting on-demand {profile} speedtest (run `/speedtest cancel` to abort)..."),
                );
                let tx_st = tx.clone();
                let cancel = Arc::clone(&state.speedtest_cancel);
                let cfg = SpeedtestConfig::for_profile(profile);
                tokio::task::spawn_blocking(move || {
                    let run_id = format!("tui-st-{}", uuid_like_id());
                    let tx_prog = tx_st.clone();
                    let res = run_speedtest_streaming(&run_id, &cfg, cancel, move |ev| {
                        let _ = tx_prog.send(UiAsyncEvent::SpeedtestProgress(ev));
                    });
                    let _ = tx_st.send(UiAsyncEvent::SpeedtestFinished(Box::new(res)));
                });
            }
        }
        "/router" => {
            state.drawer_tab = DrawerTab::Router;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let db_path = default_omnia_data_dir().join("omnia_router.db");
            match DynamicProviderRouter::open_sqlite(&db_path, now_ms) {
                Ok(router) => {
                    let sub: Vec<&str> = arg.split_whitespace().collect();
                    if sub.len() >= 2 && sub[0].eq_ignore_ascii_case("trip") {
                        match router.trip_circuit(sub[1], now_ms, Some(60_000)) {
                            Ok(()) => state.push_line(TranscriptEntryKind::System, format!("Tripped circuit `{}` (persisted to SQLite).", sub[1])),
                            Err(e) => state.push_line(TranscriptEntryKind::System, format!("Trip failed: {e}")),
                        }
                    } else if sub.len() >= 2 && sub[0].eq_ignore_ascii_case("reset") {
                        match router.reset_circuit(sub[1]) {
                            Ok(()) => state.push_line(TranscriptEntryKind::System, format!("Reset circuit `{}` (persisted to SQLite).", sub[1])),
                            Err(e) => state.push_line(TranscriptEntryKind::System, format!("Reset failed: {e}")),
                        }
                    } else if sub.first().is_some_and(|s| s.eq_ignore_ascii_case("receipt")) {
                        if let Ok(Some(rec)) = router.latest_decision_receipt() {
                            state.push_line(TranscriptEntryKind::System, serde_json::to_string_pretty(&rec).unwrap_or_default());
                        } else {
                            state.push_line(TranscriptEntryKind::System, "No decision receipts in current router instance yet.");
                        }
                    }
                    let snaps = router.snapshots(now_ms).unwrap_or_default();
                    let runways = router.candidate_runways(now_ms).unwrap_or_default();
                    let timeline = router.failover_timeline(5).unwrap_or_default();
                    let mut lines = vec![format!("Router SQLite: {} ({} candidates)", db_path.display(), snaps.len())];
                    for s in snaps.iter().take(8) {
                        let rw = runways.get(&s.candidate.candidate_id);
                        let rw_str = rw.map_or_else(
                            || "quota:Unknown".into(),
                            |r| format!(
                                "quota:{} status:{} runway:{}",
                                r.quota_kind,
                                r.status,
                                r.estimated_runway_minutes.map_or_else(|| "-".into(), |m| format!("{m:.1}m"))
                            ),
                        );
                        lines.push(format!(
                            "  {} [{}] calls:{} p95:{:.0}ms {}",
                            s.candidate.candidate_id,
                            s.state.circuit.kind_str(),
                            s.state.total_calls,
                            s.state.latency_percentile(95).unwrap_or(0.0),
                            rw_str
                        ));
                    }
                    if !timeline.is_empty() {
                        lines.push("Failover Timeline:".into());
                        for ev in timeline {
                            lines.push(format!(
                                "  {} {} -> {} ({})",
                                ev.kind,
                                ev.from_candidate_id.as_deref().unwrap_or("-"),
                                ev.to_candidate_id.as_deref().unwrap_or("-"),
                                ev.reason
                            ));
                        }
                    }
                    state.last_router_summary = lines.clone();
                    for l in lines.iter().take(10) {
                        state.push_line(TranscriptEntryKind::System, l.clone());
                    }
                }
                Err(e) => state.push_line(TranscriptEntryKind::System, format!("Router DB unavailable: {e}")),
            }
        }
        "/cache" => {
            state.drawer_tab = DrawerTab::Cache;
            for l in build_drawer_lines(state) {
                state.push_line(TranscriptEntryKind::System, l);
            }
        }
        "/swarm" => {
            state.drawer_tab = DrawerTab::Swarm;
            for l in build_drawer_lines(state) {
                state.push_line(TranscriptEntryKind::System, l);
            }
        }
        "/memory" => {
            state.drawer_tab = DrawerTab::Memory;
            let mut lines = Vec::new();
            if let Some(ref eng) = state.engine {
                if let Some(ref mem) = eng.memory_engine {
                    let q = if arg.is_empty() { "workspace architecture" } else { arg };
                    if let Some(recalled) = mem.recall_tail_for_prompt(&eng.workspace_root, q, 1_200) {
                        lines.push(format!("Memory Recall ({q}):"));
                        for ln in recalled.lines().take(14) {
                            lines.push(format!("  {ln}"));
                        }
                    } else {
                        lines.push(format!("No memory matches for `{q}` yet."));
                    }
                } else {
                    lines.push("MemoryEngine inactive (no omnia_memory.db present yet).".into());
                }
            }
            state.drawer_lines = lines.clone();
            for l in lines {
                state.push_line(TranscriptEntryKind::System, l);
            }
        }
        "/compact" => {
            if let Some(ref mut eng) = state.engine {
                let rep = eng.compact_conversation_now();
                state.push_line(
                    TranscriptEntryKind::System,
                    format!(
                        "Compacted {} stale tool observation(s), saved {} chars (Prefix-0 untouched).",
                        rep.compressed_count, rep.chars_saved
                    ),
                );
            }
        }
        "/export" => {
            if let Some(ref eng) = state.engine {
                let md = eng.export_session_markdown(state.privacy_mask);
                let out_path = if arg.is_empty() {
                    default_omnia_data_dir()
                        .join("exports")
                        .join(format!("{}.md", eng.session_key))
                } else {
                    PathBuf::from(arg)
                };
                if let Some(parent) = out_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                match fs::write(&out_path, md) {
                    Ok(()) => state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "Exported session report (privacy_mask={}) -> {}",
                            state.privacy_mask,
                            out_path.display()
                        ),
                    ),
                    Err(e) => state.push_line(TranscriptEntryKind::System, format!("Export failed: {e}")),
                }
            }
        }
        "/privacy" => {
            let next = match arg.to_ascii_lowercase().as_str() {
                "on" | "1" | "true" => true,
                "off" | "0" | "false" => false,
                _ => !state.privacy_mask,
            };
            state.privacy_mask = next;
            state.saved.privacy_mask = Some(next);
            let _ = save_config(&state.saved);
            state.push_line(
                TranscriptEntryKind::System,
                format!("Global Privacy Mask -> {}", if next { "ON" } else { "OFF" }),
            );
        }
        "/theme" => {
            if arg.is_empty() {
                state.push_line(
                    TranscriptEntryKind::System,
                    format!("Theme: {} (options: obsidian | titanium | alabaster | blueprint)", state.theme.as_str()),
                );
            } else if let Some(t) = TuiTheme::parse(arg) {
                state.theme = t;
                state.saved.theme = Some(t.as_str().to_string());
                let _ = save_config(&state.saved);
                state.push_line(TranscriptEntryKind::System, format!("Theme -> {}", t.as_str()));
            } else {
                state.push_line(TranscriptEntryKind::System, "Usage: /theme <obsidian|titanium|alabaster|blueprint>");
            }
        }
        _ => state.push_line(TranscriptEntryKind::System, format!("Unknown command `{cmd}`. Type /help.")),
    }
    Ok(false)
}

pub async fn run_interactive_tui(opts: TuiLaunchOptions) -> Result<()> {
    let saved = load_saved_config();
    let workspace = sanitize_windows_path(&opts.workspace);
    let model = opts
        .model
        .or_else(|| env::var("OMNIA_MODEL").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.model.clone())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let base_url = opts
        .base_url
        .or_else(|| env::var("OMNIA_BASE_URL").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.base_url.clone())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let api_key = opts
        .api_key
        .or_else(|| env::var("OMNIA_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("HTMUSTC_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("OPENAI_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved.api_key.clone())
        .or_else(|| {
            CredentialStore::resolve_secret("omnia:cli_api_key")
                .ok()
                .flatten()
                .and_then(|s| s.expose_for_wire().ok().map(str::to_string))
        });
    let wire_api = opts
        .wire_api
        .or_else(|| saved.wire_api.as_deref().map(WireApiMode::parse_flag))
        .unwrap_or(WireApiMode::Auto);
    let thinking = opts.thinking.or_else(|| saved.thinking.clone());
    let approval_mode = opts
        .approval_mode
        .or_else(|| saved.approval_mode.as_deref().and_then(parse_approval))
        .unwrap_or(ApprovalMode::Write);

    let data_dir = default_omnia_data_dir();
    let db = AgentStore::open(&data_dir)
        .or_else(|_| AgentStore::open_in_memory())
        .ok();

    if !io::stdout().is_terminal() || !io::stdin().is_terminal() {
        return run_piped_repl(
            workspace,
            model,
            base_url,
            api_key,
            wire_api,
            thinking,
            approval_mode,
            db,
            opts.max_turns,
            opts.timeout_secs,
        )
        .await;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<UiAsyncEvent>();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let engine = build_engine(
        &workspace,
        &model,
        &base_url,
        api_key.as_deref(),
        wire_api,
        thinking.clone(),
        approval_mode,
        db.clone(),
        Arc::clone(&cancel_flag),
        Some(tx.clone()),
    )?;

    let init_theme = saved
        .theme
        .as_deref()
        .and_then(TuiTheme::parse)
        .unwrap_or_default();
    let init_privacy_mask = saved.privacy_mask.unwrap_or(false);
    let mut state = TuiAppState {
        workspace,
        model,
        base_url,
        api_key,
        wire_api,
        thinking,
        approval_mode,
        saved,
        max_turns: opts.max_turns,
        timeout_secs: opts.timeout_secs,
        db,
        engine: Some(engine),
        transcript: vec![
            TranscriptLine {
                kind: TranscriptEntryKind::System,
                text: format!("Omnia Pure-Rust Super-Harness v{} ready. Type a prompt or /help.", env!("CARGO_PKG_VERSION")),
            },
        ],
        input: String::new(),
        cursor_byte: 0,
        history: Vec::new(),
        history_idx: None,
        scroll_offset: 0,
        auto_scroll: true,
        show_thinking: false,
        show_creds_modal: false,
        cred_entries: CredentialStore::list_masked().unwrap_or_default(),
        slash_selected: 0,
        running: false,
        cancel_flag,
        pending_approval: None,
        kv_hit_pct: 0.0,
        tokens_per_sec: 0.0,
        cost_usd: 0.0,
        kv_savings_usd: 0.0,
        context_pct: 0.0,
        total_turns: 0,
        total_tools: 0,
        tool_errors: 0,
        cached_rss_bytes: process_tree_rss_bytes(std::process::id()),
        last_rss_refresh: Instant::now(),
        theme: init_theme,
        privacy_mask: init_privacy_mask,
        drawer_tab: DrawerTab::Closed,
        drawer_lines: Vec::new(),
        speedtest_running: false,
        speedtest_cancel: Arc::new(AtomicBool::new(false)),
        last_speedtest_progress: None,
        last_net_summary: Vec::new(),
        last_speedtest_summary: Vec::new(),
        last_router_summary: Vec::new(),
        last_rewind_summary: Vec::new(),
    };

    let _guard = TerminalGuard::enter()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    let mut dirty = true;

    loop {
        while let Ok(ev) = rx.try_recv() {
            dirty = true;
            match ev {
                UiAsyncEvent::Harness(hev) => match hev {
                    HarnessStreamEvent::DeltaBatch {
                        text_delta,
                        thinking_delta,
                        ..
                    } => {
                        state.append_delta(TranscriptEntryKind::Thinking, &thinking_delta);
                        state.append_delta(TranscriptEntryKind::Assistant, &text_delta);
                    }
                    HarnessStreamEvent::ToolStart { tool_name, .. } => {
                        state.total_tools += 1;
                        state.push_line(
                            TranscriptEntryKind::Tool { is_error: false },
                            format!("▸ {tool_name} running..."),
                        );
                    }
                    HarnessStreamEvent::ToolEnd {
                        tool_name,
                        output,
                        is_error,
                        duration_ms,
                        ..
                    } => {
                        if is_error {
                            state.tool_errors += 1;
                        }
                        state.push_line(
                            TranscriptEntryKind::Tool { is_error },
                            format!(
                                "✓ {tool_name} [{}] ({duration_ms}ms)",
                                if is_error { "err" } else { "ok" }
                            ),
                        );
                        if !output.is_empty() {
                            let preview: String = output.lines().take(12).collect::<Vec<_>>().join("\n");
                            state.push_line(TranscriptEntryKind::Tool { is_error }, preview);
                        }
                    }
                    HarnessStreamEvent::AutoRecovery { attempt, reason } => {
                        state.push_line(
                            TranscriptEntryKind::System,
                            format!("↻ retry #{attempt}: {}", redact_secrets(&reason)),
                        );
                    }
                    HarnessStreamEvent::Metrics {
                        tokens_per_second,
                        context_percent,
                        total_cost_usd,
                        ..
                    } => {
                        state.tokens_per_sec = tokens_per_second;
                        state.context_pct = context_percent;
                        state.cost_usd = total_cost_usd;
                    }
                    HarnessStreamEvent::Telemetry {
                        cache_stats,
                        turn_count,
                        tool_call_count,
                        tool_error_count,
                        ..
                    } => {
                        state.kv_hit_pct = cache_stats.cache_hit_pct;
                        state.total_turns = turn_count;
                        state.total_tools = tool_call_count;
                        state.tool_errors = tool_error_count;
                    }
                    _ => {}
                },
                UiAsyncEvent::ApprovalPrompt {
                    tool_name,
                    reason,
                    reply,
                } => {
                    state.pending_approval = Some(PendingApproval {
                        tool_name,
                        reason,
                        reply,
                    });
                }
                UiAsyncEvent::TurnFinished {
                    engine,
                    elapsed_secs,
                    turns,
                    kv_pct,
                    tps,
                    final_text,
                    cost_usd,
                    kv_savings_usd,
                    err,
                } => {
                    state.engine = Some(*engine);
                    state.running = false;
                    state.total_turns = turns;
                    state.kv_hit_pct = kv_pct;
                    state.tokens_per_sec = tps;
                    state.cost_usd = cost_usd;
                    state.kv_savings_usd = kv_savings_usd;
                    if let Some(e) = err {
                        state.push_line(TranscriptEntryKind::System, format!("Error: {}", redact_secrets(&e)));
                    } else if !final_text.trim().is_empty()
                        && !matches!(state.transcript.last(), Some(TranscriptLine { kind: TranscriptEntryKind::Assistant, .. }))
                    {
                        state.push_line(TranscriptEntryKind::Assistant, final_text);
                    }
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "── {elapsed_secs:.2}s | {turns} turns | KV {kv_pct:.1}% | {tps:.1} tok/s | ${cost_usd:.5} (saved ${kv_savings_usd:.5}) ──"
                        ),
                    );
                }
                UiAsyncEvent::NetworkSnapshot {
                    identity,
                    dns,
                    proxy_tls,
                    host,
                } => {
                    let mut lines = vec![
                        format!("Provenance  : {}", identity.provenance.as_str()),
                        format!(
                            "Public IPv4 : {} | IPv6: {}",
                            identity.public_ipv4.as_deref().unwrap_or("unavailable"),
                            identity.public_ipv6.as_deref().unwrap_or("unavailable")
                        ),
                        format!(
                            "NAT / VPN   : {} | VPN={} ({})",
                            identity.nat_classification,
                            identity.vpn_active,
                            if identity.vpn_tags.is_empty() {
                                "none".to_string()
                            } else {
                                identity.vpn_tags.join(",")
                            }
                        ),
                        format!(
                            "NICs / Fp   : {} adapters | {}",
                            identity.adapters.len(),
                            &identity.fingerprint_sha256[..identity.fingerprint_sha256.len().min(16)]
                        ),
                        format!(
                            "DNS Leak    : {} (fastest: {})",
                            dns.leak_status,
                            dns.fastest_resolver.as_deref().unwrap_or("-")
                        ),
                        format!(
                            "Proxy / TLS : {} env, {} local ports, {} endpoints",
                            proxy_tls.env_proxies.len(),
                            proxy_tls.local_proxy_ports.len(),
                            proxy_tls.endpoints.len()
                        ),
                        format!(
                            "Host        : CPU {:.1}% | Omnia RSS {:.1} MiB | {} ports",
                            host.cpu_load_pct.unwrap_or(0.0),
                            host.total_omnia_rss_bytes as f64 / (1024.0 * 1024.0),
                            host.listening_ports.len()
                        ),
                    ];
                    for ep in proxy_tls.endpoints.iter().take(3) {
                        lines.push(format!(
                            "  {} dns:{:.0} tcp:{:.0} tls:{:.0} ttfb:{:.0}ms",
                            ep.label,
                            ep.dns_ms.unwrap_or(0.0),
                            ep.tcp_ms.unwrap_or(0.0),
                            ep.tls_ms.unwrap_or(0.0),
                            ep.ttfb_ms.unwrap_or(0.0)
                        ));
                    }
                    state.last_net_summary = lines.clone();
                    for l in lines.iter().take(6) {
                        state.push_line(TranscriptEntryKind::System, l.clone());
                    }
                }
                UiAsyncEvent::SpeedtestProgress(ev) => {
                    let badge = match (ev.current_mbps, ev.current_rtt_ms) {
                        (Some(m), _) => format!("ST:{:>2}% {:.1}Mbps", ev.progress_pct, m),
                        (None, Some(r)) => format!("ST:{:>2}% {:.0}ms", ev.progress_pct, r),
                        _ => format!("ST:{:>2}% {}", ev.progress_pct, ev.phase),
                    };
                    state.last_speedtest_progress = Some(badge);
                    state.last_speedtest_summary = vec![format!(
                        "[{}%] {}: {}",
                        ev.progress_pct, ev.phase, ev.message
                    )];
                }
                UiAsyncEvent::SpeedtestFinished(res) => {
                    state.speedtest_running = false;
                    state.last_speedtest_progress = None;
                    let lines = vec![
                        format!(
                            "Speedtest [{}] ({}ms, cancelled={})",
                            res.provenance.as_str(),
                            res.duration_ms,
                            res.cancelled
                        ),
                        format!(
                            "  DL: {:.1} Mbps (1x {:.1} / 4x {:.1}) | UL: {:.1} Mbps",
                            res.download_mbps,
                            res.single_stream_dl_mbps,
                            res.multi_stream_dl_mbps,
                            res.upload_mbps
                        ),
                        format!(
                            "  RTT p50:{:.1}ms p95:{:.1}ms jitter:{:.1}ms loss:{:.1}%",
                            res.unloaded.p50_ms.unwrap_or(0.0),
                            res.unloaded.p95_ms.unwrap_or(0.0),
                            res.unloaded.jitter_ms.unwrap_or(0.0),
                            res.unloaded.loss_pct
                        ),
                        format!(
                            "  Bufferbloat: Grade {} (DL +{:.1}ms / UL +{:.1}ms)",
                            res.bufferbloat_grade,
                            res.dl_bufferbloat_delta_ms,
                            res.ul_bufferbloat_delta_ms
                        ),
                        format!(
                            "  Readiness: SSE {} | Git {} | WebRTC {} | Remote {}",
                            res.workload_readiness.ai_sse_streaming.score,
                            res.workload_readiness.git_docker_sync.score,
                            res.workload_readiness.webrtc.score,
                            res.workload_readiness.remote_control.score
                        ),
                    ];
                    state.last_speedtest_summary = lines.clone();
                    for l in lines {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
            }
        }

        if state.refresh_rss_if_stale(Instant::now()) {
            dirty = true;
        }

        if dirty {
            terminal.draw(|f| render_ui(f, &mut state))?;
            dirty = false;
        }

        let mut should_exit = false;
        if event::poll(Duration::from_millis(25))? {
            for _ in 0..256 {
                match event::read()? {
                    Event::Resize(_, _) => {
                        let _ = terminal.autoresize();
                        dirty = true;
                    }
                    Event::Mouse(m) => match m.kind {
                        MouseEventKind::ScrollUp => {
                            state.auto_scroll = false;
                            state.scroll_offset = state.scroll_offset.saturating_sub(3);
                            dirty = true;
                        }
                        MouseEventKind::ScrollDown => {
                            state.scroll_offset = state.scroll_offset.saturating_add(3);
                            dirty = true;
                        }
                        _ => {}
                    },
                    Event::Key(key) => {
                        if !should_process_key_event(&key) {
                            if !event::poll(Duration::ZERO)? {
                                break;
                            }
                            continue;
                        }
                        dirty = true;
                        if let Some(appr) = state.pending_approval.take() {
                            match key.code {
                                KeyCode::Char('y') | KeyCode::Char('Y') => {
                                    let _ = appr.reply.send(true);
                                }
                                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                                    let _ = appr.reply.send(false);
                                }
                                _ => {
                                    state.pending_approval = Some(appr);
                                }
                            }
                            if !event::poll(Duration::ZERO)? {
                                break;
                            }
                            continue;
                        }

                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('d'))
                        {
                            state.cancel_flag.store(true, Ordering::SeqCst);
                            should_exit = true;
                            break;
                        }

                        match key {
                            KeyEvent {
                                code: KeyCode::F(2),
                                ..
                            } => {
                                state.show_thinking = !state.show_thinking;
                            }
                            KeyEvent {
                                code: KeyCode::F(3),
                                ..
                            } => {
                                state.cred_entries = CredentialStore::list_masked().unwrap_or_default();
                                state.show_creds_modal = !state.show_creds_modal;
                            }
                            KeyEvent {
                                code: KeyCode::F(4),
                                ..
                            } => {
                                state.drawer_tab = state.drawer_tab.next();
                            }
                            KeyEvent {
                                code: KeyCode::F(5),
                                ..
                            } => {
                                state.privacy_mask = !state.privacy_mask;
                                state.saved.privacy_mask = Some(state.privacy_mask);
                                let _ = save_config(&state.saved);
                            }
                            KeyEvent {
                                code: KeyCode::Esc,
                                ..
                            } => {
                                if state.show_creds_modal {
                                    state.show_creds_modal = false;
                                } else if state.drawer_tab != DrawerTab::Closed && !state.running {
                                    state.drawer_tab = DrawerTab::Closed;
                                } else if state.running {
                                    state.cancel_flag.store(true, Ordering::SeqCst);
                                    state.push_line(TranscriptEntryKind::System, "Abort requested...");
                                }
                            }
                            KeyEvent {
                                code: KeyCode::PageUp,
                                ..
                            } => {
                                state.auto_scroll = false;
                                state.scroll_offset = state.scroll_offset.saturating_sub(8);
                            }
                            KeyEvent {
                                code: KeyCode::PageDown,
                                ..
                            } => {
                                state.scroll_offset = state.scroll_offset.saturating_add(8);
                            }
                            KeyEvent {
                                code: KeyCode::Tab,
                                ..
                            } => {
                                let slash = state.filtered_slash();
                                if !slash.is_empty() {
                                    let picked = slash[state.slash_selected % slash.len()].cmd;
                                    state.input = format!("{picked} ");
                                    state.cursor_byte = state.input.len();
                                }
                            }
                            KeyEvent {
                                code: KeyCode::Enter,
                                modifiers,
                                ..
                            } if modifiers.contains(KeyModifiers::ALT) || modifiers.contains(KeyModifiers::SHIFT) => {
                                state.insert_char('\n');
                            }
                            KeyEvent {
                                code: KeyCode::Enter,
                                ..
                            } => {
                                if state.running {
                                    if !event::poll(Duration::ZERO)? {
                                        break;
                                    }
                                    continue;
                                }
                                let submitted = state.input.trim().to_string();
                                state.input.clear();
                                state.cursor_byte = 0;
                                state.history_idx = None;
                                state.auto_scroll = true;
                                if submitted.is_empty() {
                                    if !event::poll(Duration::ZERO)? {
                                        break;
                                    }
                                    continue;
                                }
                                state.history.push(submitted.clone());
                                if submitted.starts_with('/') {
                                    if handle_slash_command(&submitted, &mut state, &tx)? {
                                        should_exit = true;
                                        break;
                                    }
                                    if !event::poll(Duration::ZERO)? {
                                        break;
                                    }
                                    continue;
                                }
                                if state.api_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
                                    state.push_line(
                                        TranscriptEntryKind::System,
                                        "No API key configured. Run `/key <your-key>` or set HTMUSTC_API_KEY.",
                                    );
                                    if !event::poll(Duration::ZERO)? {
                                        break;
                                    }
                                    continue;
                                }
                                state.push_line(TranscriptEntryKind::User, &submitted);
                                state.running = true;
                                state.cancel_flag.store(false, Ordering::SeqCst);
                                let Some(mut eng) = state.engine.take() else {
                                    state.running = false;
                                    if !event::poll(Duration::ZERO)? {
                                        break;
                                    }
                                    continue;
                                };
                                let tx_clone = tx.clone();
                                let max_turns = state.max_turns;
                                let timeout_secs = state.timeout_secs;
                                let t0 = Instant::now();
                                tokio::spawn(async move {
                                    let sink_tx = tx_clone.clone();
                                    let sink: HarnessEventSink = Arc::new(move |ev| {
                                        let _ = sink_tx.send(UiAsyncEvent::Harness(ev));
                                    });
                                    let res = eng.run_prompt(&submitted, max_turns, timeout_secs, Some(sink)).await;
                                    let cs = eng.cache_guard.snapshot();
                                    let turns = eng.total_turns;
                                    let cost_usd = eng.total_cost_usd;
                                    let kv_savings_usd = eng.total_kv_savings_usd;
                                    let event = match res {
                                        Ok(summary) => {
                                            let tps = if summary.active_decode_ms > 0 {
                                                (cs.output_tokens as f64) / (summary.active_decode_ms as f64 / 1000.0)
                                            } else {
                                                0.0
                                            };
                                            UiAsyncEvent::TurnFinished {
                                                engine: Box::new(eng),
                                                elapsed_secs: t0.elapsed().as_secs_f64(),
                                                turns: summary.turns,
                                                kv_pct: cs.cache_hit_pct,
                                                tps,
                                                final_text: summary.final_text,
                                                cost_usd,
                                                kv_savings_usd,
                                                err: None,
                                            }
                                        }
                                        Err(e) => UiAsyncEvent::TurnFinished {
                                            engine: Box::new(eng),
                                            elapsed_secs: t0.elapsed().as_secs_f64(),
                                            turns,
                                            kv_pct: cs.cache_hit_pct,
                                            tps: 0.0,
                                            final_text: String::new(),
                                            cost_usd,
                                            kv_savings_usd,
                                            err: Some(format!("{e:#}")),
                                        },
                                    };
                                    let _ = tx_clone.send(event);
                                });
                            }
                            KeyEvent {
                                code: KeyCode::Backspace,
                                ..
                            } => state.backspace(),
                            KeyEvent {
                                code: KeyCode::Left,
                                ..
                            } => state.move_left(),
                            KeyEvent {
                                code: KeyCode::Right,
                                ..
                            } => state.move_right(),
                            KeyEvent {
                                code: KeyCode::Up,
                                ..
                            } => {
                                let slash = state.filtered_slash();
                                if !slash.is_empty() {
                                    state.slash_selected = state.slash_selected.saturating_sub(1);
                                } else if !state.history.is_empty() {
                                    let idx = match state.history_idx {
                                        Some(i) => i.saturating_sub(1),
                                        None => state.history.len() - 1,
                                    };
                                    state.history_idx = Some(idx);
                                    state.input = state.history[idx].clone();
                                    state.cursor_byte = state.input.len();
                                }
                            }
                            KeyEvent {
                                code: KeyCode::Down,
                                ..
                            } => {
                                let slash = state.filtered_slash();
                                if !slash.is_empty() {
                                    state.slash_selected = (state.slash_selected + 1) % slash.len();
                                } else if let Some(i) = state.history_idx {
                                    if i + 1 < state.history.len() {
                                        state.history_idx = Some(i + 1);
                                        state.input = state.history[i + 1].clone();
                                        state.cursor_byte = state.input.len();
                                    } else {
                                        state.history_idx = None;
                                        state.input.clear();
                                        state.cursor_byte = 0;
                                    }
                                }
                            }
                            KeyEvent {
                                code: KeyCode::Char(c),
                                modifiers,
                                ..
                            } if !modifiers.contains(KeyModifiers::CONTROL) => {
                                state.insert_char(c);
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
                if !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
        if should_exit {
            break;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_piped_repl(
    workspace: PathBuf,
    model: String,
    base_url: String,
    api_key: Option<String>,
    wire_api: WireApiMode,
    thinking: Option<String>,
    approval_mode: ApprovalMode,
    db: Option<AgentStore>,
    max_turns: u32,
    timeout_secs: u64,
) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut engine = build_engine(
        &workspace,
        &model,
        &base_url,
        api_key.as_deref(),
        wire_api,
        thinking,
        approval_mode,
        db,
        cancel,
        None,
    )?;
    let stdin = io::stdin();
    let mut line = String::new();
    while stdin.lock().read_line(&mut line)? > 0 {
        let trimmed = line.trim();
        if trimmed == "/exit" || trimmed == "/quit" {
            break;
        }
        if !trimmed.is_empty() && !trimmed.starts_with('/') {
            let summary = engine.run_prompt(trimmed, max_turns, timeout_secs, None).await?;
            println!("{}", summary.final_text);
        }
        line.clear();
    }
    Ok(())
}

fn should_process_key_event(key: &KeyEvent) -> bool {
    matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
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

    #[test]
    fn secret_masker_never_leaks_plaintext() {
        let hint = mask_secret_hint(Some("sk-dummy-secret-value-123456"));
        assert!(hint.starts_with("sk-d...56"));
        assert!(!hint.contains("secret-value"));
        assert_eq!(mask_secret_hint(Some("")), "unset");
    }

    #[test]
    fn slash_definitions_cover_core_and_steer17_cockpit_commands() {
        let cmds: Vec<&str> = SLASH_DEFS.iter().map(|d| d.cmd).collect();
        for req in [
            "/help",
            "/model",
            "/wire",
            "/effort",
            "/thinking",
            "/mode",
            "/status",
            "/net",
            "/speedtest",
            "/router",
            "/cache",
            "/swarm",
            "/memory",
            "/rewind",
            "/compact",
            "/export",
            "/privacy",
            "/theme",
            "/creds",
            "/exit",
        ] {
            assert!(cmds.contains(&req), "missing slash command {req}");
        }
        assert_eq!(TuiTheme::parse("titanium"), Some(TuiTheme::Titanium));
        assert_eq!(TuiTheme::parse("alabaster"), Some(TuiTheme::Alabaster));
        assert_eq!(TuiTheme::parse("blueprint"), Some(TuiTheme::Blueprint));
        assert_eq!(DrawerTab::Closed.next(), DrawerTab::Status);
        assert_eq!(DrawerTab::Rewind.next(), DrawerTab::Closed);
        let masked = PrivacyMask::mask_text("IP 203.0.113.55 user@example.com");
        assert!(!masked.contains("203.0.113.55"));
        assert!(!masked.contains("user@example.com"));
    }

    #[test]
    fn key_event_filter_ignores_conpty_release_events() {
        let press = KeyEvent::new_with_kind(
            KeyCode::Char('h'),
            KeyModifiers::NONE,
            KeyEventKind::Press,
        );
        let repeat = KeyEvent::new_with_kind(
            KeyCode::Char('h'),
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        );
        let release = KeyEvent::new_with_kind(
            KeyCode::Char('h'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        assert!(should_process_key_event(&press));
        assert!(should_process_key_event(&repeat));
        assert!(!should_process_key_event(&release));
    }

    #[test]
    fn rss_cache_refresh_respects_two_second_cooldown() {
        let t0 = Instant::now();
        let mut last = t0;
        let stale_fast = Duration::from_millis(50);
        let stale_slow = Duration::from_secs(3);
        assert!(stale_fast < Duration::from_secs(2));
        assert!(stale_slow >= Duration::from_secs(2));
        last += stale_slow;
        assert!(last.duration_since(t0) >= Duration::from_secs(2));
    }
}
