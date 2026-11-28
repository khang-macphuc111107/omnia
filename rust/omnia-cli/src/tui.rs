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
use omnia_agent::web_tools::{web_search_multi, WebSearchOptions, WebSearchScope};
use omnia_agent::{
    default_omnia_data_dir, process_tree_rss_bytes, redact_secrets, resolve_model_endpoint,
    sanitize_windows_path, AgentStore, ApprovalMode, HarnessEventSink, HarnessStreamEvent,
    NativeSuperEngine, PermissionsEngine, PluginRegistry, WireApiMode, WorkspaceGraphIndex,
};
use omnia_core::credentials::{CredentialStore, MaskedCredential};
use omnia_core::PrivacyMask;
use omnia_harness::artifact_os::{
    verify_artifact_content, ArtifactKind, ArtifactOs, LessonRecord, LifecycleArtifact,
    SixStateReceipt,
};
use omnia_harness::deep_think::{
    BranchKind, DeepThinkEngine, DeepThinkSession, EpistemicBand, RedTeamChallenge, ThinkBranch,
};
use omnia_harness::research_vault::{ResearchVault, VaultTier};
use omnia_harness::skill_registry::{CodifySkillRequest, SkillRegistry};
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
use serde_json::{json, Value};
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
    pub focus_mode: Option<String>,
    pub persona: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TuiFocusMode {
    #[default]
    Code,
    Web,
    Academic,
    Rag,
    Deep,
}

impl TuiFocusMode {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "code" | "solo" | "default" | "builder" => Some(Self::Code),
            "web" | "perplexity" | "search" => Some(Self::Web),
            "academic" | "papers" | "scholar" | "literature" => Some(Self::Academic),
            "rag" | "vault" | "local" => Some(Self::Rag),
            "deep" | "deep-research" | "research" | "think" => Some(Self::Deep),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Web => "web",
            Self::Academic => "academic",
            Self::Rag => "rag",
            Self::Deep => "deep",
        }
    }

    const fn pill(self) -> &'static str {
        match self {
            Self::Code => "FOCUS:CODE",
            Self::Web => "FOCUS:WEB",
            Self::Academic => "FOCUS:ACAD",
            Self::Rag => "FOCUS:RAG",
            Self::Deep => "FOCUS:DEEP",
        }
    }

    const fn prompt_directive(self) -> Option<&'static str> {
        match self {
            Self::Code => None,
            Self::Web => Some("Focus=Web: prioritize live web search, canonical URLs, and inline [S###] citations."),
            Self::Academic => Some("Focus=Academic: prioritize arXiv/OpenAlex/Europe PMC primary papers, DOIs, and evidence grades."),
            Self::Rag => Some("Focus=RAG: prioritize persistent Local [S###] and Global [G###] vault chunks with exact provenance."),
            Self::Deep => Some("Focus=Deep: combine multi-wave Deep Research with multi-hypothesis Deep Think falsification."),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TuiPersona {
    slug: &'static str,
    name: &'static str,
    badge: &'static str,
    default_model: &'static str,
    effort: &'static str,
    focus: TuiFocusMode,
    guidance: &'static str,
}

const BUILTIN_PERSONAS: &[TuiPersona] = &[
    TuiPersona {
        slug: "architect",
        name: "Principal Architect",
        badge: "ARC",
        default_model: "claude-sonnet-5-5",
        effort: "max",
        focus: TuiFocusMode::Code,
        guidance: "Optimize for systems invariants, zero-bloat tradeoffs, failure modes, and clean interfaces.",
    },
    TuiPersona {
        slug: "researcher",
        name: "Deep Researcher",
        badge: "RES",
        default_model: "gemini-4-carbon",
        effort: "max",
        focus: TuiFocusMode::Deep,
        guidance: "Verify every claim with primary sources, inline [S###]/[G###] citations, and a PRISMA Sources ledger.",
    },
    TuiPersona {
        slug: "reviewer",
        name: "Code Reviewer",
        badge: "REV",
        default_model: "gpt-6.2-sol",
        effort: "xhigh",
        focus: TuiFocusMode::Code,
        guidance: "Audit adversarially for security, concurrency races, edge cases, and exact file:line defects.",
    },
    TuiPersona {
        slug: "math",
        name: "Math & Proof Lab",
        badge: "MTH",
        default_model: "claude-sonnet-5-5",
        effort: "max",
        focus: TuiFocusMode::Academic,
        guidance: "Provide formal derivations, tight complexity bounds, and falsifiable counterexamples.",
    },
];

fn find_builtin_persona(raw: &str) -> Option<&'static TuiPersona> {
    let q = raw.trim().to_ascii_lowercase();
    if q.is_empty() {
        return None;
    }
    BUILTIN_PERSONAS
        .iter()
        .find(|p| p.slug == q || p.name.eq_ignore_ascii_case(&q) || p.badge.eq_ignore_ascii_case(&q))
        .or_else(|| {
            BUILTIN_PERSONAS
                .iter()
                .find(|p| p.name.to_ascii_lowercase().contains(&q) || p.slug.contains(&q))
        })
}

fn format_persona_pill(active_slug: Option<&str>) -> String {
    match active_slug.map(str::trim).filter(|s| !s.is_empty()) {
        None => "GEM:STD".to_string(),
        Some(slug) => match find_builtin_persona(slug) {
            Some(p) => format!("GEM:{}", p.badge),
            None => format!("GEM:{}", truncate_chars(slug, 10).to_ascii_uppercase()),
        },
    }
}

fn compose_prompt_with_focus_and_persona(
    raw_prompt: &str,
    focus: TuiFocusMode,
    persona_slug: Option<&str>,
) -> String {
    let mut prefixes = Vec::new();
    if let Some(dir) = focus.prompt_directive() {
        prefixes.push(format!("[{dir}]"));
    }
    if let Some(slug) = persona_slug.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(p) = find_builtin_persona(slug) {
            prefixes.push(format!("[Persona: {} — {}]", p.name, p.guidance));
        } else {
            prefixes.push(format!("[Persona: {slug}]"));
        }
    }
    if prefixes.is_empty() {
        raw_prompt.to_string()
    } else {
        format!("{}\n\n{raw_prompt}", prefixes.join("\n"))
    }
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

    const fn drawer_fg(self) -> Color {
        match self {
            Self::Obsidian => Color::Gray,
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
    Research,
    Lifecycle,
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
            Self::Memory => Self::Research,
            Self::Research => Self::Lifecycle,
            Self::Lifecycle => Self::Rewind,
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
            Self::Research => "Research & Deep Think",
            Self::Lifecycle => "12-Artifact Lifecycle",
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
        desc: "Approval (default: yolo/turbo/full-access/auto-approve) | write | plan | always-ask",
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
        cmd: "/research",
        usage: "/research <query>",
        desc: "Live RAG recall + web/academic search with [S###]/[G###] citations",
    },
    SlashDef {
        cmd: "/sources",
        usage: "/sources [local|global|export]",
        desc: "Sources (Searched, Viewed & Extracted) ledger & dossier export",
    },
    SlashDef {
        cmd: "/rag",
        usage: "/rag <query|pin <id>>",
        desc: "Query or pin persistent Local+Global [S###]/[G###] RAG vault",
    },
    SlashDef {
        cmd: "/think",
        usage: "/think <topic|list|branch|falsify|redteam|conclude>",
        desc: "Deep Think multi-hypothesis branches, falsification & red-team",
    },
    SlashDef {
        cmd: "/goal",
        usage: "/goal [set <title> | <body>]",
        desc: "Inspect or update Goal lifecycle artifact & 6-state receipt",
    },
    SlashDef {
        cmd: "/spec",
        usage: "/spec [set <title> | <body>]",
        desc: "Inspect or update Spec lifecycle artifact (AC-1..N)",
    },
    SlashDef {
        cmd: "/blueprint",
        usage: "/blueprint [set <title> | <body>]",
        desc: "Inspect or update Architecture Blueprint lifecycle artifact",
    },
    SlashDef {
        cmd: "/plan",
        usage: "/plan [set <title> | <body>]",
        desc: "Inspect or update Execution Plan lifecycle artifact",
    },
    SlashDef {
        cmd: "/todo",
        usage: "/todo [add <title>|done <id> [proof]]",
        desc: "Inspect, add, or receipt-verify Todo lifecycle tasks",
    },
    SlashDef {
        cmd: "/progress",
        usage: "/progress [update <note>|phase <name>]",
        desc: "Inspect Progress & SuperWorkflowState wave/strike/DoD counts",
    },
    SlashDef {
        cmd: "/dod",
        usage: "/dod [add <title>|pass <id> <proof>]",
        desc: "Inspect or receipt-gate Definition of Done (DoD) verification",
    },
    SlashDef {
        cmd: "/handoff",
        usage: "/handoff [write <title> | <body>]",
        desc: "Inspect/write Handoff preserving AGENT_NOTES & 6-state receipt",
    },
    SlashDef {
        cmd: "/learn",
        usage: "/learn [<title> | <cause> | <invariant>]",
        desc: "Capture 2-tier lesson w/ overlap check or inspect Gap Radar",
    },
    SlashDef {
        cmd: "/lessons",
        usage: "/lessons [project|global]",
        desc: "List verified 2-tier project/global engineering lessons",
    },
    SlashDef {
        cmd: "/skills",
        usage: "/skills [query|dag <q>|pipelines|doctor|codify]",
        desc: "Bilingual VN-EN BM25 + Cold Vault router, 4-stage DAG & doctor",
    },
    SlashDef {
        cmd: "/arena",
        usage: "/arena <m1,m2> <prompt>",
        desc: "Parallel 2-4 model Arena compare w/ elapsed ms, tok/s & USD",
    },
    SlashDef {
        cmd: "/persona",
        usage: "/persona [list|use <name>|off]",
        desc: "List or activate Omnia Gems / Personas in the TUI HUD",
    },
    SlashDef {
        cmd: "/focus",
        usage: "/focus <web|academic|code|rag|deep>",
        desc: "Switch active Focus Mode pill (web|academic|code|rag|deep)",
    },
    SlashDef {
        cmd: "/fork",
        usage: "/fork [label|list|switch <id>]",
        desc: "Fork current TUI thread snapshot & switch branched threads",
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

fn format_approval_badge(m: ApprovalMode) -> &'static str {
    match m {
        ApprovalMode::Yolo => "YOLO · AUTO",
        ApprovalMode::Write => "WRITE",
        ApprovalMode::Plan => "PLAN",
        ApprovalMode::AlwaysAsk => "ASK",
        ApprovalMode::AlwaysAskCached => "ASK-CACHED",
    }
}

pub fn parse_approval(raw: &str) -> Option<ApprovalMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "yolo" | "turbo" | "full-access" | "full" | "unrestricted" | "auto" | "auto-approve" => {
            Some(ApprovalMode::Yolo)
        }
        "write" => Some(ApprovalMode::Write),
        "plan" | "read-only" | "readonly" => Some(ApprovalMode::Plan),
        "always-ask" | "ask" => Some(ApprovalMode::AlwaysAsk),
        "always-ask-cached" | "cached" => Some(ApprovalMode::AlwaysAskCached),
        _ => None,
    }
}

fn resolve_tui_approval_mode(
    cli_override: Option<ApprovalMode>,
    saved_mode: Option<&str>,
) -> ApprovalMode {
    cli_override
        .or_else(|| saved_mode.and_then(parse_approval))
        .unwrap_or(ApprovalMode::Yolo)
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

#[derive(Debug, Clone)]
struct ArenaModelOutcome {
    model: String,
    status: String,
    elapsed_ms: u64,
    output_tokens: u64,
    tps: f64,
    cost_usd: f64,
    preview: String,
}

#[derive(Debug, Clone)]
struct ForkedThreadSnapshot {
    branch_id: String,
    label: String,
    parent_session: String,
    model: String,
    focus_mode: TuiFocusMode,
    persona: Option<String>,
    transcript: Vec<TranscriptLine>,
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
    ResearchCompleted {
        query: String,
        transcript_lines: Vec<String>,
        drawer_lines: Vec<String>,
    },
    ArenaCompleted {
        prompt: String,
        results: Vec<ArenaModelOutcome>,
    },
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
    last_research_summary: Vec<String>,
    last_lifecycle_summary: Vec<String>,
    skill_registry: Option<SkillRegistry>,
    focus_mode: TuiFocusMode,
    active_persona: Option<String>,
    forked_threads: Vec<ForkedThreadSnapshot>,
}

impl TuiAppState {
    fn ensure_skill_registry(&mut self) -> &SkillRegistry {
        if self.skill_registry.is_none() {
            self.skill_registry = Some(open_skill_registry(&self.workspace));
        }
        self.skill_registry.as_ref().expect("skill_registry initialized")
    }

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
        true,
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
        Span::raw(" · "),
        Span::styled(
            format!("{} ", format_approval_badge(state.approval_mode)),
            if state.approval_mode == ApprovalMode::Yolo {
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Yellow)
            },
        ),
        Span::styled("| ", Style::default().fg(border_col)),
        Span::styled(
            format!(" {} ", state.focus_mode.pill()),
            Style::default()
                .fg(Color::Black)
                .bg(accent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            format!(" {} ", format_persona_pill(state.active_persona.as_deref())),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Magenta)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
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
        let drawer_fg = state.theme.drawer_fg();
        let d_lines: Vec<Line> = build_drawer_lines(state)
            .into_iter()
            .map(|l| {
                let masked = state.mask_if_enabled(&l);
                let style = if masked.starts_with("=== ") || masked.starts_with("--- ") {
                    Style::default().fg(accent).add_modifier(Modifier::BOLD)
                } else if masked.contains("[BLOCKED_BY_CHALLENGE]")
                    || masked.contains("[AUTH_REQUIRED]")
                    || masked.contains("[ERR]")
                    || masked.contains("strike_")
                {
                    Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(drawer_fg)
                };
                Line::from(Span::styled(masked, style))
            })
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
    let fork_badge = if state.forked_threads.is_empty() {
        String::new()
    } else {
        format!(" | forks:{}", state.forked_threads.len())
    };
    let persona_pill = format_persona_pill(state.active_persona.as_deref());
    let hud = Line::from(vec![
        Span::styled(
            format!(
                " {} | {} | {} | turns:{} tools:{}(err:{}) | KV:{:.1}% | {:.1} tok/s | ctx:{:.0}% | ${:.4} (saved ${:.4}) | RSS:{:.1}MiB | budget:NULL{}{}{} ",
                format_approval_badge(state.approval_mode),
                state.focus_mode.pill(),
                persona_pill,
                state.total_turns,
                state.total_tools,
                state.tool_errors,
                state.kv_hit_pct,
                state.tokens_per_sec,
                state.context_pct,
                state.cost_usd,
                state.kv_savings_usd,
                rss_mb,
                fork_badge,
                st_badge,
                mask_badge
            ),
            Style::default().fg(state.theme.hud_fg()).bg(state.theme.hud_bg()),
        ),
    ]);
    frame.render_widget(Paragraph::new(hud), chunks[3]);

    // 5. Slash Command Autocomplete Overlay (windowed scroll across all commands)
    let slash_items = state.filtered_slash();
    if !slash_items.is_empty() && !state.running {
        let popup_h = (slash_items.len() as u16 + 2).min(12);
        let visible_rows = popup_h.saturating_sub(2) as usize;
        let selected_idx = state.slash_selected % slash_items.len();
        let start = selected_idx.saturating_sub(visible_rows.saturating_sub(1));
        let end = (start + visible_rows).min(slash_items.len());
        let popup_area = Rect {
            x: chunks[2].x + 1,
            y: chunks[2].y.saturating_sub(popup_h),
            width: chunks[2].width.saturating_sub(2).min(88),
            height: popup_h,
        };
        let drawer_fg = state.theme.drawer_fg();
        let list_items: Vec<ListItem> = slash_items[start..end]
            .iter()
            .enumerate()
            .map(|(offset, s)| {
                let i = start + offset;
                let style = if i == selected_idx {
                    Style::default()
                        .bg(accent)
                        .fg(Color::Black)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(drawer_fg)
                };
                ListItem::new(Line::from(format!("{:<24} {}", s.usage, s.desc))).style(style)
            })
            .collect();
        frame.render_widget(Clear, popup_area);
        frame.render_widget(
            List::new(list_items).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(accent))
                    .title(format!(
                        " Slash Commands ({}/{}) [Tab/Enter] ",
                        selected_idx + 1,
                        slash_items.len()
                    )),
            ),
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
        DrawerTab::Research => {
            if state.last_research_summary.is_empty() {
                vec![
                    "=== Research Vault & Deep Think ===".into(),
                    "Run /research <query>, /sources, /rag <query>, or /think <topic>.".into(),
                ]
            } else {
                state.last_research_summary.clone()
            }
        }
        DrawerTab::Lifecycle => {
            if state.last_lifecycle_summary.is_empty() {
                vec![
                    "=== 12-Artifact Proactive Lifecycle ===".into(),
                    "Run /goal /spec /blueprint /plan /todo /progress /dod /handoff /learn /lessons /skills.".into(),
                ]
            } else {
                state.last_lifecycle_summary.clone()
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
                "Core: /model /wire /effort /mode /cd /key /base-url /creds /status /net /speedtest /router /cache /swarm /memory /rewind /compact /export /privacy /theme /clear /exit",
            );
            state.push_line(
                TranscriptEntryKind::System,
                "Steer #18-23: /research /sources /rag /think | /arena /persona /focus /fork | /goal /spec /blueprint /plan /todo /progress /dod /handoff /learn /lessons /skills",
            );
            state.push_line(
                TranscriptEntryKind::System,
                "Keys: F2 thinking | F3 creds | F4 cockpit drawer (incl. Research & Lifecycle) | F5 privacy mask | PgUp/PgDn scroll | Esc abort/close",
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
            if arg.is_empty() {
                state.push_line(
                    TranscriptEntryKind::System,
                    format!(
                        "Approval mode: {} ({}) — default: yolo (turbo | full-access | full | unrestricted | auto | auto-approve)",
                        format_approval(state.approval_mode),
                        format_approval_badge(state.approval_mode)
                    ),
                );
            } else if let Some(mode) = parse_approval(arg) {
                state.approval_mode = mode;
                state.saved.approval_mode = Some(format_approval(mode).to_string());
                let _ = save_config(&state.saved);
                if let Some(ref mut eng) = state.engine {
                    eng.tool_runtime.approval_mode = mode;
                    eng.tool_runtime.workspace_trusted = true;
                }
                state.push_line(
                    TranscriptEntryKind::System,
                    format!(
                        "Approval -> {} ({})",
                        format_approval(mode),
                        format_approval_badge(mode)
                    ),
                );
            } else {
                state.push_line(
                    TranscriptEntryKind::System,
                    "Usage: /mode <yolo|turbo|full-access|full|unrestricted|auto|auto-approve|write|plan|always-ask>",
                );
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
                state.skill_registry = None;
                state.last_research_summary.clear();
                state.last_lifecycle_summary.clear();
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
        "/research" => {
            state.drawer_tab = DrawerTab::Research;
            let (query, scope, tier, auto_fetch, offline) = parse_research_args(arg);
            if query.is_empty() {
                refresh_research_drawer(state);
                state.push_line(
                    TranscriptEntryKind::System,
                    "Usage: /research [--scope web|academic|all] [--global] [--no-fetch] [--offline] <query>",
                );
                for l in state.last_research_summary.clone().into_iter().take(12) {
                    state.push_line(TranscriptEntryKind::System, l);
                }
            } else {
                let stage0_lines = match open_research_vault(&state.workspace) {
                    Ok(vault) => format_rag_query_lines(&vault, &query, None, 5),
                    Err(e) => vec![format!("ResearchVault unavailable: {e}")],
                };
                if offline {
                    state.last_research_summary = stage0_lines.clone();
                    for l in stage0_lines {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                } else {
                    let mut preview = vec![
                        format!(
                            "=== Research: {} (scope:{:?} tier:{} fetch:{}) ===",
                            truncate_chars(&query, 44),
                            scope,
                            tier.as_str(),
                            auto_fetch
                        ),
                        "Stage 0 RAG recall complete; searching web/academic backends...".into(),
                    ];
                    preview.extend(stage0_lines.iter().take(6).cloned());
                    state.last_research_summary = preview;
                    for l in stage0_lines.into_iter().take(6) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "Running live {:?} research search for `{}` (auto_fetch={})...",
                            scope, query, auto_fetch
                        ),
                    );
                    let tx_res = tx.clone();
                    let ws_clone = state.workspace.clone();
                    tokio::spawn(async move {
                        let (t_lines, d_lines) =
                            run_live_research_task(&ws_clone, &query, scope, tier, auto_fetch)
                                .await;
                        let _ = tx_res.send(UiAsyncEvent::ResearchCompleted {
                            query,
                            transcript_lines: t_lines,
                            drawer_lines: d_lines,
                        });
                    });
                }
            }
        }
        "/sources" => {
            state.drawer_tab = DrawerTab::Research;
            let tokens: Vec<&str> = arg.split_whitespace().collect();
            match open_research_vault(&state.workspace) {
                Ok(vault) => {
                    if tokens.first().is_some_and(|t| t.eq_ignore_ascii_case("export")) {
                        match vault.export_dossier("markdown", None) {
                            Ok(raw_md) => {
                                let md = if state.privacy_mask {
                                    PrivacyMask::mask_text(&raw_md)
                                } else {
                                    raw_md
                                };
                                let out_path = tokens.get(1).map_or_else(
                                    || {
                                        default_omnia_data_dir()
                                            .join("exports")
                                            .join(format!("research-dossier-{}.md", uuid_like_id()))
                                    },
                                    PathBuf::from,
                                );
                                if let Some(parent) = out_path.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                match fs::write(&out_path, md) {
                                    Ok(()) => state.push_line(
                                        TranscriptEntryKind::System,
                                        format!(
                                            "Exported Research Dossier (privacy_mask={}) -> {}",
                                            state.privacy_mask,
                                            out_path.display()
                                        ),
                                    ),
                                    Err(e) => state.push_line(
                                        TranscriptEntryKind::System,
                                        format!("Dossier export failed: {e}"),
                                    ),
                                }
                            }
                            Err(e) => state.push_line(
                                TranscriptEntryKind::System,
                                format!("Dossier build failed: {e}"),
                            ),
                        }
                    } else {
                        let tier_filter = match tokens
                            .first()
                            .map(|s| s.to_ascii_lowercase())
                            .as_deref()
                        {
                            Some("local" | "s") => Some(VaultTier::Local),
                            Some("global" | "g") => Some(VaultTier::Global),
                            _ => None,
                        };
                        let lines = format_sources_ledger_lines(&vault, tier_filter);
                        state.last_research_summary = lines.clone();
                        for l in lines.into_iter().take(18) {
                            state.push_line(TranscriptEntryKind::System, l);
                        }
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ResearchVault error: {e}"));
                }
            }
        }
        "/rag" => {
            state.drawer_tab = DrawerTab::Research;
            match open_research_vault(&state.workspace) {
                Ok(vault) => {
                    let lines = execute_rag_command(&vault, arg);
                    state.last_research_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ResearchVault error: {e}"));
                }
            }
        }
        "/think" => {
            state.drawer_tab = DrawerTab::Research;
            let session_key = state.engine.as_ref().map_or_else(
                || "tui-session".to_string(),
                |e| e.session_key.clone(),
            );
            let effort = state.thinking.as_deref().unwrap_or("max");
            match open_deep_think() {
                Ok(eng) => {
                    let lines = execute_think_command(&eng, &session_key, &state.model, effort, arg);
                    state.last_research_summary = lines.clone();
                    for l in lines.into_iter().take(20) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("DeepThink error: {e}"));
                }
            }
        }
        "/goal" | "/spec" | "/blueprint" | "/plan" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            let kind = match cmd {
                "/goal" => ArtifactKind::Goal,
                "/spec" => ArtifactKind::Spec,
                "/blueprint" => ArtifactKind::Blueprint,
                _ => ArtifactKind::Plan,
            };
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_lifecycle_artifact_command(&os, &state.workspace, kind, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/todo" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_todo_command(&os, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/progress" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_progress_command(&os, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/dod" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_dod_command(&os, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/handoff" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_handoff_command(&os, &state.workspace, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/learn" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_learn_command(&os, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/lessons" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            match open_artifact_os(&state.workspace) {
                Ok(os) => {
                    let lines = execute_lessons_command(&os, arg);
                    state.last_lifecycle_summary = lines.clone();
                    for l in lines.into_iter().take(18) {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                Err(e) => {
                    state.push_line(TranscriptEntryKind::System, format!("ArtifactOs error: {e}"));
                }
            }
        }
        "/skills" => {
            state.drawer_tab = DrawerTab::Lifecycle;
            if arg.eq_ignore_ascii_case("reload") {
                state.skill_registry = None;
            }
            let ws = state.workspace.clone();
            let lines = {
                let reg = state.ensure_skill_registry();
                execute_skills_command(reg, &ws, arg)
            };
            state.last_lifecycle_summary = lines.clone();
            for l in lines.into_iter().take(20) {
                state.push_line(TranscriptEntryKind::System, l);
            }
        }
        "/arena" => {
            state.drawer_tab = DrawerTab::Research;
            match parse_arena_args(arg) {
                Ok((models, prompt)) => {
                    let header = format!(
                        "Launching parallel Arena ({} models: {}) for `{}`...",
                        models.len(),
                        models.join(", "),
                        truncate_chars(&prompt, 52)
                    );
                    state.last_research_summary = vec![
                        "=== Multi-Model Parallel Arena ===".into(),
                        header.clone(),
                    ];
                    state.push_line(TranscriptEntryKind::System, header);
                    let req = ArenaRunRequest {
                        workspace: state.workspace.clone(),
                        base_url: state.base_url.clone(),
                        api_key: state.api_key.clone(),
                        wire_api: state.wire_api,
                        thinking: state.thinking.clone(),
                        timeout_secs: state.timeout_secs.min(90),
                        models,
                        prompt: compose_prompt_with_focus_and_persona(
                            &prompt,
                            state.focus_mode,
                            state.active_persona.as_deref(),
                        ),
                        display_prompt: prompt,
                    };
                    let tx_arena = tx.clone();
                    tokio::spawn(async move {
                        let prompt_lbl = req.display_prompt.clone();
                        let results = run_parallel_arena_task(req).await;
                        let _ = tx_arena.send(UiAsyncEvent::ArenaCompleted {
                            prompt: prompt_lbl,
                            results,
                        });
                    });
                }
                Err(usage) => {
                    state.push_line(TranscriptEntryKind::System, usage);
                }
            }
        }
        "/persona" => {
            let trimmed = arg.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("list") {
                for l in format_persona_list_lines(state.active_persona.as_deref()) {
                    state.push_line(TranscriptEntryKind::System, l);
                }
            } else if matches!(
                trimmed.to_ascii_lowercase().as_str(),
                "off" | "clear" | "none" | "default" | "reset"
            ) {
                state.active_persona = None;
                state.saved.persona = None;
                let _ = save_config(&state.saved);
                state.push_line(
                    TranscriptEntryKind::System,
                    "Persona -> default (GEM:STD)",
                );
            } else {
                let target = trimmed
                    .strip_prefix("use ")
                    .or_else(|| trimmed.strip_prefix("USE "))
                    .unwrap_or(trimmed)
                    .trim();
                if let Some(p) = find_builtin_persona(target) {
                    state.active_persona = Some(p.slug.to_string());
                    state.focus_mode = p.focus;
                    state.thinking = Some(p.effort.to_string());
                    state.saved.persona = state.active_persona.clone();
                    state.saved.focus_mode = Some(p.focus.as_str().to_string());
                    state.saved.thinking = state.thinking.clone();
                    let _ = save_config(&state.saved);
                    if let Some(ref mut eng) = state.engine {
                        eng.thinking_level = state.thinking.clone();
                    }
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "Persona -> {} [GEM:{}] | {} | effort:{} (recommended model: {})",
                            p.name,
                            p.badge,
                            p.focus.pill(),
                            p.effort,
                            p.default_model
                        ),
                    );
                } else {
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "Unknown persona `{target}`. Run `/persona list` (architect | researcher | reviewer | math | off)."
                        ),
                    );
                }
            }
        }
        "/focus" => {
            if arg.is_empty() {
                state.push_line(
                    TranscriptEntryKind::System,
                    format!(
                        "Active Focus: {} ({}) — options: web | academic | code | rag | deep",
                        state.focus_mode.as_str(),
                        state.focus_mode.pill()
                    ),
                );
            } else if let Some(mode) = TuiFocusMode::parse(arg) {
                state.focus_mode = mode;
                state.saved.focus_mode = Some(mode.as_str().to_string());
                let _ = save_config(&state.saved);
                state.push_line(
                    TranscriptEntryKind::System,
                    format!("Focus -> {} ({})", mode.as_str(), mode.pill()),
                );
            } else {
                state.push_line(
                    TranscriptEntryKind::System,
                    "Usage: /focus <web|academic|code|rag|deep>",
                );
            }
        }
        "/fork" => {
            let trimmed = arg.trim();
            if trimmed.eq_ignore_ascii_case("list") {
                for l in format_fork_list_lines(&state.forked_threads) {
                    state.push_line(TranscriptEntryKind::System, l);
                }
            } else if let Some(target_id) = trimmed
                .strip_prefix("switch ")
                .or_else(|| trimmed.strip_prefix("SWITCH "))
                .map(str::trim)
            {
                if let Some(snap) = state
                    .forked_threads
                    .iter()
                    .find(|f| f.branch_id.eq_ignore_ascii_case(target_id))
                    .cloned()
                {
                    state.transcript = snap.transcript;
                    state.model = snap.model;
                    state.focus_mode = snap.focus_mode;
                    state.active_persona = snap.persona;
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
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!(
                            "Switched to fork `{}` [{}] ({} | {})",
                            snap.branch_id,
                            snap.label,
                            state.focus_mode.pill(),
                            format_persona_pill(state.active_persona.as_deref())
                        ),
                    );
                } else {
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!("Fork `{target_id}` not found. Run `/fork list`."),
                    );
                }
            } else {
                let parent_session = state
                    .engine
                    .as_ref()
                    .map_or_else(|| "tui-root".to_string(), |e| e.session_key.clone());
                let snap = create_fork_snapshot(
                    state.forked_threads.len() + 1,
                    trimmed,
                    &parent_session,
                    &state.model,
                    state.focus_mode,
                    state.active_persona.as_deref(),
                    &state.transcript,
                );
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
                let new_sid = eng.session_key.clone();
                state.engine = Some(eng);
                let msg = format!(
                    "Forked thread -> `{}` [{}] from {} ({} lines preserved; new session `{}`; use `/fork list` or `/fork switch {}`)",
                    snap.branch_id,
                    snap.label,
                    snap.parent_session,
                    snap.transcript.len(),
                    new_sid,
                    snap.branch_id
                );
                state.forked_threads.push(snap);
                state.push_line(TranscriptEntryKind::System, msg);
            }
        }
        _ => state.push_line(TranscriptEntryKind::System, format!("Unknown command `{cmd}`. Type /help.")),
    }
    Ok(false)
}

struct ArenaRunRequest {
    workspace: PathBuf,
    base_url: String,
    api_key: Option<String>,
    wire_api: WireApiMode,
    thinking: Option<String>,
    timeout_secs: u64,
    models: Vec<String>,
    prompt: String,
    display_prompt: String,
}

fn parse_arena_args(raw: &str) -> Result<(Vec<String>, String), String> {
    let usage = "Usage: /arena <m1,m2[,m3,m4]> <prompt> (e.g. /arena claude-sonnet-5-5,gpt-6.2-sol Compare Rust WAL vs LMDB)";
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(usage.to_string());
    }
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let models_raw = parts.next().unwrap_or("");
    let prompt = parts.next().unwrap_or("").trim();
    if prompt.is_empty() {
        return Err(usage.to_string());
    }
    let mut models = Vec::new();
    for m in models_raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !models.iter().any(|existing: &String| existing.eq_ignore_ascii_case(m)) {
            models.push(m.to_string());
        }
    }
    if models.len() < 2 {
        return Err(format!("Arena requires 2..=4 comma-separated models. {usage}"));
    }
    if models.len() > 4 {
        return Err(format!("Arena supports at most 4 models per parallel run (got {}).", models.len()));
    }
    Ok((models, prompt.to_string()))
}

async fn run_parallel_arena_task(req: ArenaRunRequest) -> Vec<ArenaModelOutcome> {
    let has_key = req
        .api_key
        .as_deref()
        .is_some_and(|k| !k.trim().is_empty());
    if !has_key {
        let est_tokens = req.prompt.len().div_ceil(4) as u64;
        return req
            .models
            .into_iter()
            .map(|m| ArenaModelOutcome {
                model: m,
                status: "unconfigured_provider".to_string(),
                elapsed_ms: 0,
                output_tokens: 0,
                tps: 0.0,
                cost_usd: 0.0,
                preview: format!(
                    "No API key configured (run `/key <secret>` or set OMNIA_API_KEY); pre-send est ~{est_tokens} input tok."
                ),
            })
            .collect();
    }

    let mut set = tokio::task::JoinSet::new();
    for (idx, model_id) in req.models.into_iter().enumerate() {
        let ws = req.workspace.clone();
        let base_url = req.base_url.clone();
        let api_key = req.api_key.clone();
        let wire_api = req.wire_api;
        let thinking = req.thinking.clone();
        let prompt = req.prompt.clone();
        let timeout_secs = req.timeout_secs.clamp(10, 90);
        set.spawn(async move {
            let t0 = Instant::now();
            let cancel = Arc::new(AtomicBool::new(false));
            let eng_res = build_engine(
                &ws,
                &model_id,
                &base_url,
                api_key.as_deref(),
                wire_api,
                thinking,
                ApprovalMode::Plan,
                None,
                cancel,
                None,
            );
            let outcome = match eng_res {
                Ok(mut eng) => match eng.run_prompt(&prompt, 1, timeout_secs, None).await {
                    Ok(sum) => {
                        let cs = eng.cache_guard.snapshot();
                        let tps = if sum.active_decode_ms > 0 {
                            (cs.output_tokens as f64) / (sum.active_decode_ms as f64 / 1000.0)
                        } else {
                            0.0
                        };
                        ArenaModelOutcome {
                            model: model_id,
                            status: "ok".to_string(),
                            elapsed_ms: t0.elapsed().as_millis() as u64,
                            output_tokens: cs.output_tokens,
                            tps,
                            cost_usd: eng.total_cost_usd,
                            preview: truncate_chars(
                                &redact_secrets(sum.final_text.trim()).replace('\n', " "),
                                180,
                            ),
                        }
                    }
                    Err(e) => ArenaModelOutcome {
                        model: model_id,
                        status: "error".to_string(),
                        elapsed_ms: t0.elapsed().as_millis() as u64,
                        output_tokens: 0,
                        tps: 0.0,
                        cost_usd: eng.total_cost_usd,
                        preview: truncate_chars(&redact_secrets(&format!("{e:#}")), 140),
                    },
                },
                Err(e) => ArenaModelOutcome {
                    model: model_id,
                    status: "error".to_string(),
                    elapsed_ms: t0.elapsed().as_millis() as u64,
                    output_tokens: 0,
                    tps: 0.0,
                    cost_usd: 0.0,
                    preview: truncate_chars(&redact_secrets(&format!("{e:#}")), 140),
                },
            };
            (idx, outcome)
        });
    }

    let mut ordered = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            ordered.push(item);
        }
    }
    ordered.sort_by_key(|(idx, _)| *idx);
    ordered.into_iter().map(|(_, o)| o).collect()
}

fn format_arena_results_lines(prompt: &str, results: &[ArenaModelOutcome]) -> Vec<String> {
    let mut out = vec![
        format!("=== Arena Compare ({} models) ===", results.len()),
        format!("Prompt: {}", truncate_chars(prompt, 72)),
    ];
    for r in results {
        out.push(format!(
            "  {} [{}] {}ms | out:{}t | {:.1} tok/s | ${:.6}",
            r.model, r.status, r.elapsed_ms, r.output_tokens, r.tps, r.cost_usd
        ));
        if !r.preview.is_empty() {
            out.push(format!("    {}", truncate_chars(&r.preview, 110)));
        }
    }
    out
}

fn format_persona_list_lines(active_slug: Option<&str>) -> Vec<String> {
    let mut out = vec![format!(
        "=== Omnia Gems / Personas (active: {}) ===",
        format_persona_pill(active_slug)
    )];
    for p in BUILTIN_PERSONAS {
        let marker = if active_slug.is_some_and(|s| s.eq_ignore_ascii_case(p.slug)) {
            "*"
        } else {
            " "
        };
        out.push(format!(
            " {marker} {:<10} [{}] {:<20} | {} | effort:{} | model:{}",
            p.slug,
            p.badge,
            p.name,
            p.focus.pill(),
            p.effort,
            p.default_model
        ));
        out.push(format!("    {}", truncate_chars(p.guidance, 86)));
    }
    out.push("Usage: /persona use <architect|researcher|reviewer|math> | /persona off".into());
    out
}

fn create_fork_snapshot(
    index: usize,
    raw_label: &str,
    parent_session: &str,
    model: &str,
    focus_mode: TuiFocusMode,
    persona: Option<&str>,
    transcript: &[TranscriptLine],
) -> ForkedThreadSnapshot {
    let branch_id = format!("fork-{index}");
    let label = if raw_label.trim().is_empty() {
        format!("branch-{index}")
    } else {
        truncate_chars(raw_label.trim(), 32)
    };
    ForkedThreadSnapshot {
        branch_id,
        label,
        parent_session: parent_session.to_string(),
        model: model.to_string(),
        focus_mode,
        persona: persona.map(ToString::to_string),
        transcript: transcript.to_vec(),
    }
}

fn format_fork_list_lines(forks: &[ForkedThreadSnapshot]) -> Vec<String> {
    let mut out = vec![format!("=== Forked Threads ({}) ===", forks.len())];
    if forks.is_empty() {
        out.push("  (no forked threads yet — run `/fork [label]` to branch the current session)".into());
    } else {
        for f in forks {
            out.push(format!(
                "  {} [{}] parent:{} | {} | {} | {} | {} lines",
                f.branch_id,
                f.label,
                f.parent_session,
                f.model,
                f.focus_mode.pill(),
                format_persona_pill(f.persona.as_deref()),
                f.transcript.len()
            ));
        }
        out.push("Use `/fork switch <fork-id>` to restore a forked branch.".into());
    }
    out
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    let mut iter = raw.chars();
    let head: String = iter.by_ref().take(max_chars).collect();
    if iter.next().is_some() {
        format!("{head}...")
    } else {
        head
    }
}

fn slugify_tui(raw: &str) -> String {
    let s: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        format!("item-{}", uuid_like_id())
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn open_research_vault(workspace: &Path) -> Result<ResearchVault, String> {
    let global_dir = default_omnia_data_dir().join("research-vault");
    ResearchVault::open(workspace, Some(&global_dir))
        .or_else(|_| ResearchVault::open_in_memory())
}

fn open_deep_think() -> Result<DeepThinkEngine, String> {
    let db_path = default_omnia_data_dir()
        .join("memory")
        .join("omnia_deep_think.db");
    DeepThinkEngine::open(&db_path).or_else(|_| DeepThinkEngine::open_in_memory())
}

fn open_artifact_os(workspace: &Path) -> Result<ArtifactOs, String> {
    let mem_dir = default_omnia_data_dir().join("memory");
    let db_path = mem_dir.join("omnia_artifact_os.db");
    ArtifactOs::open(workspace, &db_path, Some(&mem_dir))
        .or_else(|_| ArtifactOs::open_in_memory(workspace))
}

fn open_skill_registry(workspace: &Path) -> SkillRegistry {
    let reg = SkillRegistry::new();
    let _ = reg.load_from_workspace(workspace);
    let _ = reg.load_default_cold_vault();
    reg
}

fn parse_research_args(raw: &str) -> (String, WebSearchScope, VaultTier, bool, bool) {
    let mut scope = WebSearchScope::All;
    let mut tier = VaultTier::Local;
    let mut auto_fetch = true;
    let mut offline = false;
    let mut query_parts = Vec::new();
    let mut tokens = raw.split_whitespace();
    while let Some(tok) = tokens.next() {
        if tok == "--scope" {
            if let Some(val) = tokens.next() {
                scope = WebSearchScope::parse(Some(val));
            }
        } else if let Some(val) = tok.strip_prefix("--scope=") {
            scope = WebSearchScope::parse(Some(val));
        } else if tok == "--web" {
            scope = WebSearchScope::Web;
        } else if tok == "--academic" {
            scope = WebSearchScope::Academic;
        } else if tok == "--global" {
            tier = VaultTier::Global;
        } else if tok == "--no-fetch" {
            auto_fetch = false;
        } else if tok == "--offline" {
            offline = true;
        } else {
            query_parts.push(tok);
        }
    }
    (query_parts.join(" "), scope, tier, auto_fetch, offline)
}

async fn run_live_research_task(
    workspace: &Path,
    query: &str,
    scope: WebSearchScope,
    tier: VaultTier,
    auto_fetch: bool,
) -> (Vec<String>, Vec<String>) {
    let mut t_lines = Vec::new();
    let bundle = match web_search_multi(&WebSearchOptions {
        query: query.to_owned(),
        limit: 6,
        scope,
        ..Default::default()
    })
    .await
    {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("Web/academic search error: {}", redact_secrets(&format!("{e:#}")));
            return (vec![msg.clone()], vec!["=== Research & Deep Think ===".into(), msg]);
        }
    };

    t_lines.push(format!(
        "Search `{}` | providers: {} | hits: {}",
        truncate_chars(query, 44),
        bundle.providers_queried.join("+"),
        bundle.hits.len()
    ));
    if !bundle.provider_errors.is_empty() {
        t_lines.push(format!(
            "Provider warnings: {}",
            truncate_chars(&redact_secrets(&bundle.provider_errors.join("; ")), 120)
        ));
    }

    match open_research_vault(workspace) {
        Ok(vault) => {
            let mut recorded_ids = Vec::new();
            let mut fetch_urls = Vec::new();
            for hit in &bundle.hits {
                if let Ok(rec) = vault.record_searched_candidate(
                    tier,
                    &hit.canonical_url,
                    &hit.title,
                    query,
                    &hit.snippet,
                ) {
                    if fetch_urls.len() < 3 {
                        fetch_urls.push(hit.canonical_url.clone());
                    }
                    recorded_ids.push(rec);
                }
            }
            let fetched = if auto_fetch && !fetch_urls.is_empty() {
                vault
                    .fetch_urls_parallel(tier, &fetch_urls, query, 3, false)
                    .await
            } else {
                Vec::new()
            };
            for src in fetched.iter().take(4) {
                let tag = src
                    .error_kind
                    .as_ref()
                    .map_or_else(String::new, |k| format!(" {}", k.tag()));
                t_lines.push(format!(
                    "  [{}] ({}) [{}]{} {} — {}",
                    src.citation_id,
                    src.tier.as_str(),
                    src.stage.as_str(),
                    tag,
                    truncate_chars(&src.title, 48),
                    truncate_chars(&src.canonical_url, 64)
                ));
            }
            if fetched.is_empty() {
                for src in recorded_ids.iter().take(4) {
                    t_lines.push(format!(
                        "  [{}] ({}) [searched] {} — {}",
                        src.citation_id,
                        src.tier.as_str(),
                        truncate_chars(&src.title, 48),
                        truncate_chars(&src.canonical_url, 64)
                    ));
                }
            }
            let rag_hits = vault.query_rag(query, None, 5).unwrap_or_default();
            if !rag_hits.is_empty() {
                t_lines.push(format!("Persistent RAG Citations ({} hits):", rag_hits.len()));
                for h in rag_hits.iter().take(4) {
                    t_lines.push(format!(
                        "  [{}] ({}) rrf:{:.4} {} | {}",
                        h.citation_id,
                        h.tier.as_str(),
                        h.rrf_score,
                        truncate_chars(&h.title, 36),
                        truncate_chars(&h.snippet, 88)
                    ));
                }
            }
            let d_lines = match open_deep_think() {
                Ok(dt) => format_research_drawer_snapshot(&vault, &dt),
                Err(_) => format_sources_ledger_lines(&vault, None),
            };
            (t_lines, d_lines)
        }
        Err(e) => {
            t_lines.push(format!("ResearchVault persist skipped: {e}"));
            let d_lines = t_lines.clone();
            (t_lines, d_lines)
        }
    }
}

fn format_sources_ledger_lines(vault: &ResearchVault, tier: Option<VaultTier>) -> Vec<String> {
    let mut out = vec!["=== Sources (Searched, Viewed & Extracted) ===".into()];
    match vault.sources_ledger(tier) {
        Ok(ledger) => {
            let claims = vault.count_claims(None).unwrap_or(0);
            out.push(format!(
                "Extracted:{} | Viewed:{} | Searched:{} | Blocked:{} | AuthReq:{} | Failed:{}",
                ledger.total_extracted,
                ledger.total_viewed,
                ledger.total_searched,
                ledger.total_blocked,
                ledger.total_auth_required,
                ledger.total_failed
            ));
            out.push(format!(
                "Claims:{} | Cited IDs: {} | Total Listed: {}",
                claims,
                if ledger.cited_ids.is_empty() {
                    "none".to_string()
                } else {
                    ledger
                        .cited_ids
                        .iter()
                        .take(8)
                        .map(|c| format!("[{c}]"))
                        .collect::<Vec<_>>()
                        .join(" ")
                },
                ledger.sources.len()
            ));
            if ledger.sources.is_empty() {
                out.push("  (no sources yet — run `/research <query>` to populate Local/Global RAG)".into());
            } else {
                for s in ledger.sources.iter().take(12) {
                    let pin = if s.pinned { "*" } else { "" };
                    let http = s
                        .http_status
                        .map_or_else(|| "no-http".into(), |c| format!("HTTP {c}"));
                    let err_tag = s
                        .error_kind
                        .as_ref()
                        .map_or_else(String::new, |k| format!(" {}", k.tag()));
                    out.push(format!(
                        "  [{}]{} ({}) [{}|{}]{} {} | {}",
                        s.citation_id,
                        pin,
                        s.tier.as_str(),
                        s.stage.as_str(),
                        http,
                        err_tag,
                        truncate_chars(&s.title, 34),
                        truncate_chars(&s.canonical_url, 52)
                    ));
                }
            }
        }
        Err(e) => out.push(format!("Ledger error: {e}")),
    }
    out
}

fn format_rag_query_lines(
    vault: &ResearchVault,
    query: &str,
    tier: Option<VaultTier>,
    top_k: usize,
) -> Vec<String> {
    let mut out = vec![format!(
        "=== Persistent RAG Recall: `{}` ===",
        truncate_chars(query, 40)
    )];
    match vault.query_rag(query, tier, top_k) {
        Ok(hits) if !hits.is_empty() => {
            for h in hits {
                out.push(format!(
                    "  [{}] ({}) rrf:{:.4} bm25:{:.2} | {}",
                    h.citation_id,
                    h.tier.as_str(),
                    h.rrf_score,
                    h.bm25_score,
                    truncate_chars(&h.title, 42)
                ));
                out.push(format!(
                    "    {} — {}",
                    truncate_chars(&h.source_url, 56),
                    truncate_chars(&h.snippet, 84)
                ));
            }
        }
        Ok(_) => {
            out.push(format!("No persisted Local/Global RAG chunks matched `{query}` yet."));
        }
        Err(e) => out.push(format!("RAG query error: {e}")),
    }
    out
}

fn execute_rag_command(vault: &ResearchVault, arg: &str) -> Vec<String> {
    let trimmed = arg.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("status") {
        return format_sources_ledger_lines(vault, None);
    }
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens[0].eq_ignore_ascii_case("pin") {
        let Some(cid) = tokens.get(1) else {
            return vec!["Usage: /rag pin <S###|G###> [global|local]".into()];
        };
        let target = tokens
            .get(2)
            .copied()
            .map_or(VaultTier::Global, VaultTier::from_str_lossy);
        return match vault.pin_source(cid, target) {
            Ok(src) => vec![
                "=== RAG Source Pinned ===".into(),
                format!(
                    "Pinned [{}] in `{}` tier (pinned={}): {} — {}",
                    src.citation_id,
                    src.tier.as_str(),
                    src.pinned,
                    truncate_chars(&src.title, 44),
                    truncate_chars(&src.canonical_url, 56)
                ),
            ],
            Err(e) => vec![format!("RAG pin failed: {e}")],
        };
    }
    let (tier, q) = if tokens[0].eq_ignore_ascii_case("local") && tokens.len() > 1 {
        (Some(VaultTier::Local), tokens[1..].join(" "))
    } else if tokens[0].eq_ignore_ascii_case("global") && tokens.len() > 1 {
        (Some(VaultTier::Global), tokens[1..].join(" "))
    } else {
        (None, trimmed.to_string())
    };
    format_rag_query_lines(vault, &q, tier, 8)
}

fn format_deep_think_session_lines(sess: &DeepThinkSession) -> Vec<String> {
    let mut out = vec![
        format!(
            "=== Deep Think `{}` [{} | effort:{}] ===",
            sess.think_id, sess.stage, sess.effort
        ),
        format!("Problem : {}", truncate_chars(&sess.problem, 72)),
        format!(
            "Strikes : {} (level:{}, fails:{}) | Winner: {}",
            sess.escalation.status,
            sess.escalation.strike_level,
            sess.escalation.consecutive_failures,
            sess.winner_branch_id.as_deref().unwrap_or("undecided")
        ),
    ];
    if !sess.branches.is_empty() {
        out.push(format!("--- Branches ({}) ---", sess.branches.len()));
        for b in &sess.branches {
            let fals = match b.falsification_passed {
                Some(true) => "PASS",
                Some(false) => "FAIL",
                None => "PENDING",
            };
            out.push(format!(
                "  {} [{:?} | {:?}] fals:{} score:{}bp — {}",
                b.branch_id,
                b.kind,
                b.epistemic_band,
                fals,
                b.score_bps,
                truncate_chars(&b.title, 44)
            ));
            if let Some(ref rcpt) = b.falsification_receipt {
                out.push(format!(
                    "    receipt: {} ({})",
                    truncate_chars(rcpt, 64),
                    b.falsification_cmd.as_deref().unwrap_or("-")
                ));
            }
        }
    }
    if !sess.red_team.is_empty() {
        out.push(format!("--- Red-Team ({}) ---", sess.red_team.len()));
        for rt in &sess.red_team {
            out.push(format!(
                "  {} vs {} (distinct_family={}) -> {}",
                rt.challenger_model, rt.primary_model, rt.distinct_family, rt.verdict
            ));
            for c in rt.critiques.iter().take(2) {
                out.push(format!("    critique: {}", truncate_chars(c, 72)));
            }
        }
    }
    if sess.winner_branch_id.is_some() {
        let rejected = DeepThinkEngine::rejected_alternatives_matrix(sess);
        if !rejected.is_empty() {
            out.push(format!("Rejected Alternatives: {}", rejected.len()));
        }
    }
    if let Some(ref syn) = sess.synthesis {
        out.push(format!("Synthesis: {}", truncate_chars(syn, 88)));
    }
    for w in &sess.warnings {
        out.push(format!("  [WARN] {}", truncate_chars(w, 80)));
    }
    out
}

fn execute_think_command(
    eng: &DeepThinkEngine,
    session_key: &str,
    primary_model: &str,
    effort: &str,
    arg: &str,
) -> Vec<String> {
    let trimmed = arg.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("list") {
        return match eng.list_sessions(None, 8) {
            Ok(sessions) if !sessions.is_empty() => {
                let mut out = format_deep_think_session_lines(&sessions[0]);
                if sessions.len() > 1 {
                    out.push("--- Recent Deep Think Sessions ---".into());
                    for s in sessions.iter().skip(1).take(5) {
                        out.push(format!(
                            "  {} [{}] branches:{} strikes:{} — {}",
                            s.think_id,
                            s.stage,
                            s.branches.len(),
                            s.escalation.strike_level,
                            truncate_chars(&s.problem, 48)
                        ));
                    }
                }
                out
            }
            Ok(_) => vec![
                "=== Deep Think Engine ===".into(),
                "No Deep Think sessions yet. Run `/think <topic>` to frame invariants & hypotheses.".into(),
            ],
            Err(e) => vec![format!("DeepThink list error: {e}")],
        };
    }

    let mut split = trimmed.splitn(2, char::is_whitespace);
    let sub = split.next().unwrap_or("");
    let rest = split.next().unwrap_or("").trim();

    if sub.eq_ignore_ascii_case("show") {
        if rest.is_empty() {
            return vec!["Usage: /think show <think_id>".into()];
        }
        return match eng.get_session(rest) {
            Ok(Some(sess)) => format_deep_think_session_lines(&sess),
            Ok(None) => vec![format!("Deep Think session `{rest}` not found.")],
            Err(e) => vec![format!("DeepThink show error: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("branch") {
        let mut p = rest.splitn(3, char::is_whitespace);
        let Some(tid) = p.next().filter(|s| !s.is_empty()) else {
            return vec!["Usage: /think branch <think_id> <baseline|sota|contrarian> <title> [| <hypothesis>]".into()];
        };
        let Some(kind_str) = p.next().filter(|s| !s.is_empty()) else {
            return vec!["Usage: /think branch <think_id> <baseline|sota|contrarian> <title> [| <hypothesis>]".into()];
        };
        let body = p.next().unwrap_or("").trim();
        if body.is_empty() {
            return vec!["Usage: /think branch <think_id> <baseline|sota|contrarian> <title> [| <hypothesis>]".into()];
        }
        let (title, hyp) = match body.split_once('|') {
            Some((t, h)) => (t.trim(), h.trim()),
            None => (body, body),
        };
        let br = ThinkBranch {
            branch_id: String::new(),
            kind: BranchKind::from_str_lossy(kind_str),
            title: title.to_string(),
            hypothesis: hyp.to_string(),
            complexity: "O(N)".to_string(),
            failure_modes: Vec::new(),
            blast_radius: "scoped".to_string(),
            citations: Vec::new(),
            epistemic_band: EpistemicBand::Hypothesis,
            falsification_cmd: None,
            falsification_passed: None,
            falsification_receipt: None,
            score_bps: 7_000,
            rejected_reason: None,
        };
        return match eng.add_branch(tid, br) {
            Ok(sess) => format_deep_think_session_lines(&sess),
            Err(e) => vec![format!("DeepThink branch error: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("falsify") {
        let mut p = rest.splitn(4, char::is_whitespace);
        let (Some(tid), Some(bid), Some(verdict), Some(cmd_rest)) =
            (p.next(), p.next(), p.next(), p.next())
        else {
            return vec!["Usage: /think falsify <think_id> <branch_id> <pass|fail> <cmd> [| <receipt>]".into()];
        };
        let passed = matches!(
            verdict.to_ascii_lowercase().as_str(),
            "pass" | "passed" | "true" | "ok" | "1"
        );
        let (cmd_s, rcpt_s) = match cmd_rest.split_once('|') {
            Some((c, r)) => (c.trim(), r.trim()),
            None => (cmd_rest.trim(), if passed { "PASS" } else { "FAIL" }),
        };
        return match eng.record_falsification(tid, bid, cmd_s, passed, rcpt_s) {
            Ok(sess) => format_deep_think_session_lines(&sess),
            Err(e) => vec![format!("DeepThink falsify error: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("redteam") {
        let mut p = rest.splitn(3, char::is_whitespace);
        let (Some(tid), Some(challenger), Some(critique)) = (p.next(), p.next(), p.next()) else {
            return vec!["Usage: /think redteam <think_id> <challenger_model> <critique>".into()];
        };
        let challenge = RedTeamChallenge {
            challenger_model: challenger.to_string(),
            primary_model: primary_model.to_string(),
            distinct_family: false,
            critiques: vec![critique.trim().to_string()],
            mitigations: Vec::new(),
            verdict: "reviewed".to_string(),
            created_at_ms: 0,
        };
        return match eng.record_redteam(tid, challenge) {
            Ok(sess) => format_deep_think_session_lines(&sess),
            Err(e) => vec![format!("DeepThink redteam error: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("conclude") {
        let mut p = rest.splitn(3, char::is_whitespace);
        let (Some(tid), Some(winner), Some(synthesis)) = (p.next(), p.next(), p.next()) else {
            return vec!["Usage: /think conclude <think_id> <winner_branch_id> <synthesis>".into()];
        };
        let receipt = json!({
            "verified": [format!("Winner `{winner}` selected via TUI /think conclude")],
            "partial": [],
            "unresolved": [],
            "blocked": [],
            "next": [],
            "exactPracticalLimits": ["Independent runtime verification recommended."]
        });
        return match eng.conclude_session(tid, winner, synthesis, receipt) {
            Ok(sess) => format_deep_think_session_lines(&sess),
            Err(e) => vec![format!("DeepThink conclude error: {e}")],
        };
    }

    match eng.start_session(session_key, trimmed, Vec::new(), Vec::new(), effort) {
        Ok(sess) => {
            let mut out = format_deep_think_session_lines(&sess);
            out.push(format!(
                "Next: `/think branch {} baseline|sota|contrarian <title> | <hypothesis>`",
                sess.think_id
            ));
            out
        }
        Err(e) => vec![format!("DeepThink start error: {e}")],
    }
}

fn format_research_drawer_snapshot(vault: &ResearchVault, think: &DeepThinkEngine) -> Vec<String> {
    let mut out = format_sources_ledger_lines(vault, None);
    if let Ok(sessions) = think.list_sessions(None, 1) {
        if let Some(sess) = sessions.first() {
            out.push("--- Latest Deep Think ---".into());
            out.extend(format_deep_think_session_lines(sess).into_iter().take(10));
        }
    }
    out
}

fn format_receipt_badge(receipt: Option<&SixStateReceipt>) -> String {
    match receipt {
        Some(r) => format!(
            "6st[V:{} P:{} U:{} B:{} N:{} L:{}]",
            r.verified.len(),
            r.partial.len(),
            r.unresolved.len(),
            r.blocked.len(),
            r.next.len(),
            r.exact_practical_limits.len()
        ),
        None => "6st[none]".to_string(),
    }
}

fn format_artifact_lines(kind: ArtifactKind, items: &[LifecycleArtifact]) -> Vec<String> {
    let mut out = vec![format!(
        "=== Lifecycle `{}` Artifacts ({}) ===",
        kind.as_str(),
        items.len()
    )];
    for a in items.iter().take(10) {
        out.push(format!(
            "  {} [{}] {} | links:{} sha:{}",
            a.id,
            a.status,
            format_receipt_badge(a.receipt.as_ref()),
            a.links.len(),
            truncate_chars(&a.sha256_hex, 12)
        ));
        out.push(format!(
            "    {} — {}",
            truncate_chars(&a.title, 44),
            truncate_chars(&a.body_md.replace('\n', " "), 64)
        ));
    }
    out
}

fn strip_sync_flag(raw: &str) -> (String, bool) {
    let mut sync = false;
    let kept: Vec<&str> = raw
        .split_whitespace()
        .filter(|t| {
            if *t == "--sync" {
                sync = true;
                false
            } else {
                true
            }
        })
        .collect();
    (kept.join(" "), sync)
}

fn execute_lifecycle_artifact_command(
    os: &ArtifactOs,
    workspace: &Path,
    kind: ArtifactKind,
    arg: &str,
) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    if cleaned.is_empty() {
        let items = os.list_artifacts(Some(kind), None).unwrap_or_default();
        let mut out = format_artifact_lines(kind, &items);
        if items.is_empty() {
            let doc_name = match kind {
                ArtifactKind::Goal => "GOAL.md",
                ArtifactKind::Spec => "SPEC.md",
                ArtifactKind::Blueprint => "BLUEPRINT.md",
                ArtifactKind::Plan => "PLAN.md",
                _ => "STATUS.md",
            };
            let ws_doc = workspace.join("docs").join("workspace").join(doc_name);
            if ws_doc.is_file() {
                out.push(format!("Workspace doc detected: {}", ws_doc.display()));
            }
            out.push(format!(
                "Usage: /{} set <title> | <body> [--sync]",
                kind.as_str()
            ));
        }
        return out;
    }

    let payload = cleaned
        .strip_prefix("set ")
        .or_else(|| cleaned.strip_prefix("SET "))
        .unwrap_or(&cleaned)
        .trim();
    let (title, body) = match payload.split_once('|') {
        Some((t, b)) => (t.trim(), b.trim()),
        None => (payload, payload),
    };
    let slug = slugify_tui(title);
    match os.upsert_artifact(
        kind,
        &slug,
        title,
        "active",
        "project",
        body,
        json!({ "source": "tui" }),
        None,
        sync_to_disk,
    ) {
        Ok(art) => {
            let ver = verify_artifact_content(&art.body_md, None, None, None);
            let mut out = format_artifact_lines(kind, &[art]);
            out.push(format!(
                "Verify: ok={} lf={} secrets={} tok~={} sha:{}",
                ver.ok,
                ver.lf_only,
                ver.secret_findings,
                ver.estimated_tokens,
                truncate_chars(&ver.sha256_hex, 12)
            ));
            out
        }
        Err(e) => vec![format!("Upsert {} failed: {e}", kind.as_str())],
    }
}

fn execute_todo_command(os: &ArtifactOs, arg: &str) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    if cleaned.is_empty() {
        let items = os.list_artifacts(Some(ArtifactKind::Todo), None).unwrap_or_default();
        let mut out = format_artifact_lines(ArtifactKind::Todo, &items);
        if let Ok(st) = os.super_state() {
            out.push(format!(
                "SuperState: open_todos={} | phase={} wave={}",
                st.open_todos, st.phase, st.wave
            ));
        }
        if items.is_empty() {
            out.push("Usage: /todo add <title> | /todo done <id> [proof]".into());
        }
        return out;
    }

    let mut parts = cleaned.splitn(2, char::is_whitespace);
    let sub = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();

    if sub.eq_ignore_ascii_case("done") {
        let mut dp = rest.splitn(2, char::is_whitespace);
        let Some(id) = dp.next().filter(|s| !s.is_empty()) else {
            return vec!["Usage: /todo done <artifact_id> [verified_evidence]".into()];
        };
        let ev = dp.next().map(str::trim).filter(|s| !s.is_empty());
        return match os.update_todo_status(id, "done", ev) {
            Ok(art) => format_artifact_lines(ArtifactKind::Todo, &[art]),
            Err(e) => vec![format!("Todo done failed: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("status") {
        let mut sp = rest.splitn(3, char::is_whitespace);
        let (Some(id), Some(st)) = (sp.next(), sp.next()) else {
            return vec!["Usage: /todo status <artifact_id> <open|in_progress|done|blocked> [proof]".into()];
        };
        let ev = sp.next().map(str::trim).filter(|s| !s.is_empty());
        return match os.update_todo_status(id, st, ev) {
            Ok(art) => format_artifact_lines(ArtifactKind::Todo, &[art]),
            Err(e) => vec![format!("Todo status update failed: {e}")],
        };
    }

    let body_raw = if sub.eq_ignore_ascii_case("add") {
        rest
    } else {
        cleaned.as_str()
    };
    if body_raw.is_empty() {
        return vec!["Usage: /todo add <title> [| <detail>] [--sync]".into()];
    }
    let (title, body) = match body_raw.split_once('|') {
        Some((t, b)) => (t.trim(), b.trim()),
        None => (body_raw, body_raw),
    };
    match os.upsert_artifact(
        ArtifactKind::Todo,
        &slugify_tui(title),
        title,
        "open",
        "project",
        body,
        json!({ "source": "tui" }),
        None,
        sync_to_disk,
    ) {
        Ok(art) => format_artifact_lines(ArtifactKind::Todo, &[art]),
        Err(e) => vec![format!("Todo add failed: {e}")],
    }
}

fn execute_progress_command(os: &ArtifactOs, arg: &str) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    let mut out = vec!["=== Progress & SuperWorkflowState ===".into()];
    if !cleaned.is_empty() {
        let mut parts = cleaned.splitn(3, char::is_whitespace);
        let first = parts.next().unwrap_or("");
        if first.eq_ignore_ascii_case("phase") {
            let phase = parts.next().unwrap_or("executing");
            let wave = parts.next().and_then(|w| w.parse::<u32>().ok());
            let patch = if let Some(w) = wave {
                json!({ "phase": phase, "wave": w })
            } else {
                json!({ "phase": phase })
            };
            match os.update_super_state(patch, sync_to_disk) {
                Ok(st) => out.push(format!("Updated SuperState -> phase:{} wave:{}", st.phase, st.wave)),
                Err(e) => out.push(format!("SuperState update failed: {e}")),
            }
        } else {
            let note = cleaned
                .strip_prefix("update ")
                .or_else(|| cleaned.strip_prefix("UPDATE "))
                .unwrap_or(&cleaned)
                .trim();
            if let Ok(art) = os.upsert_artifact(
                ArtifactKind::Progress,
                &format!("log-{}", uuid_like_id()),
                &truncate_chars(note, 48),
                "active",
                "project",
                note,
                json!({ "source": "tui" }),
                None,
                sync_to_disk,
            ) {
                out.push(format!("Logged progress `{}` (sha:{})", art.id, truncate_chars(&art.sha256_hex, 12)));
            }
        }
    }
    if let Ok(st) = os.super_state() {
        out.push(format!(
            "Phase: {} | Wave: {} | Strikes: {} | Open Todos: {} | DoD Verified: {}/{}",
            st.phase, st.wave, st.strike_count, st.open_todos, st.verified_dod_gates, st.total_dod_gates
        ));
        out.push(format!(
            "Active Goal: {} | Spec: {} | Plan: {} | Handoff: {}",
            st.active_goal_id.as_deref().unwrap_or("-"),
            st.active_spec_id.as_deref().unwrap_or("-"),
            st.active_plan_id.as_deref().unwrap_or("-"),
            st.last_handoff_id.as_deref().unwrap_or("-")
        ));
    }
    let items = os.list_artifacts(Some(ArtifactKind::Progress), None).unwrap_or_default();
    for p in items.iter().take(6) {
        out.push(format!(
            "  {} [{}] {} — {}",
            p.id,
            p.status,
            format_receipt_badge(p.receipt.as_ref()),
            truncate_chars(&p.title, 48)
        ));
    }
    out
}

fn execute_dod_command(os: &ArtifactOs, arg: &str) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    if cleaned.is_empty() {
        let items = os.list_artifacts(Some(ArtifactKind::Dod), None).unwrap_or_default();
        let mut out = format_artifact_lines(ArtifactKind::Dod, &items);
        if items.is_empty() {
            out.push("Usage: /dod add <title> | /dod pass <id> <verified_evidence> | /dod fail <id> <reason>".into());
        }
        return out;
    }

    let mut parts = cleaned.splitn(2, char::is_whitespace);
    let sub = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();

    if sub.eq_ignore_ascii_case("pass") {
        let mut pp = rest.splitn(2, char::is_whitespace);
        let Some(id) = pp.next().filter(|s| !s.is_empty()) else {
            return vec!["Usage: /dod pass <dod_id> <verified_evidence>".into()];
        };
        let mut receipt = SixStateReceipt::default();
        if let Some(ev) = pp.next().map(str::trim).filter(|s| !s.is_empty()) {
            receipt.verified.push(ev.to_string());
        }
        return match os.update_dod_gate(id, true, receipt) {
            Ok(art) => format_artifact_lines(ArtifactKind::Dod, &[art]),
            Err(e) => vec![format!("DoD gate rejected: {e}")],
        };
    }
    if sub.eq_ignore_ascii_case("fail") {
        let mut fp = rest.splitn(2, char::is_whitespace);
        let Some(id) = fp.next().filter(|s| !s.is_empty()) else {
            return vec!["Usage: /dod fail <dod_id> <reason>".into()];
        };
        let mut receipt = SixStateReceipt::default();
        let reason = fp.next().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("failed verification");
        receipt.unresolved.push(reason.to_string());
        return match os.update_dod_gate(id, false, receipt) {
            Ok(art) => format_artifact_lines(ArtifactKind::Dod, &[art]),
            Err(e) => vec![format!("DoD update failed: {e}")],
        };
    }

    let body_raw = if sub.eq_ignore_ascii_case("add") {
        rest
    } else {
        cleaned.as_str()
    };
    let (title, body) = match body_raw.split_once('|') {
        Some((t, b)) => (t.trim(), b.trim()),
        None => (body_raw, body_raw),
    };
    match os.upsert_artifact(
        ArtifactKind::Dod,
        &slugify_tui(title),
        title,
        "open",
        "project",
        body,
        json!({ "source": "tui" }),
        None,
        sync_to_disk,
    ) {
        Ok(art) => format_artifact_lines(ArtifactKind::Dod, &[art]),
        Err(e) => vec![format!("DoD add failed: {e}")],
    }
}

fn execute_handoff_command(os: &ArtifactOs, workspace: &Path, arg: &str) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    if cleaned.is_empty() {
        let items = os.list_artifacts(Some(ArtifactKind::Handoff), None).unwrap_or_default();
        let mut out = format_artifact_lines(ArtifactKind::Handoff, &items);
        let disk_h = workspace.join(".agents").join("memory").join("HANDOFF.md");
        if disk_h.is_file() {
            out.push(format!("Disk handoff present: {}", disk_h.display()));
        }
        if items.is_empty() {
            out.push("Usage: /handoff write <title> | <body> [--sync] (preserves AGENT_NOTES block)".into());
        }
        return out;
    }

    let payload = cleaned
        .strip_prefix("write ")
        .or_else(|| cleaned.strip_prefix("WRITE "))
        .unwrap_or(&cleaned)
        .trim();
    let (title, body) = match payload.split_once('|') {
        Some((t, b)) => (t.trim(), b.trim()),
        None => ("Session Handoff", payload),
    };
    let mut rcpt = SixStateReceipt::default();
    if let Ok(st) = os.super_state() {
        rcpt.verified.push(format!(
            "DoD gates {}/{} verified",
            st.verified_dod_gates, st.total_dod_gates
        ));
        if st.open_todos > 0 {
            rcpt.next.push(format!("{} open todo(s) remaining", st.open_todos));
        }
    }
    match os.write_handoff_preserving_notes(title, body, rcpt, sync_to_disk) {
        Ok(art) => {
            let ver = verify_artifact_content(&art.body_md, None, None, None);
            let mut out = format_artifact_lines(ArtifactKind::Handoff, &[art]);
            out.push(format!(
                "AGENT_NOTES preserved | verify ok={} lf={} secrets={}",
                ver.ok, ver.lf_only, ver.secret_findings
            ));
            out
        }
        Err(e) => vec![format!("Handoff write failed: {e}")],
    }
}

fn execute_learn_command(os: &ArtifactOs, arg: &str) -> Vec<String> {
    let (cleaned, sync_to_disk) = strip_sync_flag(arg);
    if cleaned.is_empty() {
        let mut out = vec!["=== Auto-Learn & Gap Radar ===".into()];
        if let Ok(rep) = os.gap_radar_report() {
            let total = rep["totalGapEvents"].as_u64().unwrap_or(0);
            out.push(format!("Gap Radar Events: {total}"));
            if let Some(cands) = rep["upgradeCandidates"].as_array() {
                for c in cands.iter().take(5) {
                    out.push(format!(
                        "  hotspot `{}` (x{}) — {}",
                        c["topic"].as_str().unwrap_or("-"),
                        c["occurrences"].as_u64().unwrap_or(0),
                        truncate_chars(c["recommendation"].as_str().unwrap_or(""), 56)
                    ));
                }
            }
        }
        out.push("Usage: /learn <title> | <root_cause> | <invariant> [| project|global] [--sync]".into());
        return out;
    }

    let segs: Vec<&str> = cleaned.split('|').map(str::trim).filter(|s| !s.is_empty()).collect();
    let (title, root_cause, invariant, scope) = match segs.len() {
        0 => return vec!["Usage: /learn <title> | <root_cause> | <invariant> [| project|global]".into()],
        1 => (segs[0], "Captured via TUI /learn", segs[0], "project"),
        2 => (segs[0], segs[0], segs[1], "project"),
        3 => (segs[0], segs[1], segs[2], "project"),
        _ => (segs[0], segs[1], segs[2], segs[3]),
    };
    let rec = LessonRecord {
        id: String::new(),
        scope: scope.to_string(),
        title: title.to_string(),
        symptom: title.to_string(),
        root_cause: root_cause.to_string(),
        invariant: invariant.to_string(),
        anti_pattern: String::new(),
        verify_cmd: String::new(),
        tags: vec!["tui".into()],
        provenance_sha: String::new(),
        promoted_skill_slug: None,
        overlap_warning: None,
        created_at_ms: 0,
    };
    match os.capture_lesson(rec, sync_to_disk) {
        Ok(saved) => {
            let mut out = vec![
                "=== Lesson Captured ===".into(),
                format!(
                    "  {} [{}] {} (sha:{})",
                    saved.id,
                    saved.scope,
                    truncate_chars(&saved.title, 48),
                    truncate_chars(&saved.provenance_sha, 12)
                ),
                format!("  Invariant: {}", truncate_chars(&saved.invariant, 76)),
            ];
            if let Some(ref warn) = saved.overlap_warning {
                out.push(format!("  [OVERLAP] {}", truncate_chars(warn, 88)));
            }
            out
        }
        Err(e) => vec![format!("Capture lesson failed: {e}")],
    }
}

fn execute_lessons_command(os: &ArtifactOs, arg: &str) -> Vec<String> {
    let scope = match arg.trim().to_ascii_lowercase().as_str() {
        "project" => Some("project"),
        "global" => Some("global"),
        _ => None,
    };
    match os.list_lessons(scope) {
        Ok(lessons) => {
            let mut out = vec![format!(
                "=== 2-Tier Lessons ({}, scope:{}) ===",
                lessons.len(),
                scope.unwrap_or("all")
            )];
            if lessons.is_empty() {
                out.push("  (no lessons recorded yet — run `/learn <title> | <cause> | <invariant>`)".into());
            } else {
                for l in lessons.iter().take(12) {
                    let promo = l
                        .promoted_skill_slug
                        .as_deref()
                        .map_or_else(String::new, |s| format!(" -> skill:{s}"));
                    out.push(format!(
                        "  {} [{}]{} {} (sha:{})",
                        l.id,
                        l.scope,
                        promo,
                        truncate_chars(&l.title, 42),
                        truncate_chars(&l.provenance_sha, 10)
                    ));
                    out.push(format!("    inv: {}", truncate_chars(&l.invariant, 74)));
                }
            }
            out
        }
        Err(e) => vec![format!("List lessons failed: {e}")],
    }
}

fn execute_skills_command(reg: &SkillRegistry, workspace: &Path, arg: &str) -> Vec<String> {
    let trimmed = arg.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("doctor") {
        let doc = reg.doctor();
        let mut out = vec![
            format!(
                "=== Skills Registry & Cold Vault [ok:{}] ===",
                doc.ok
            ),
            format!(
                "Active: {} | Cold Vault: {} | Startup: ~{} tok (<1000 ceiling)",
                doc.total_skills, doc.cold_vault_count, doc.startup_tokens_est
            ),
            format!(
                "Merkle SHA-256: {} | Findings: {}",
                truncate_chars(&doc.merkle_root_sha256, 16),
                doc.findings.len()
            ),
        ];
        if trimmed.eq_ignore_ascii_case("doctor") {
            for f in doc.findings.iter().take(8) {
                out.push(format!(
                    "  [{}] {}: {}",
                    f["severity"].as_str().unwrap_or("info"),
                    f["skill"].as_str().unwrap_or("-"),
                    f["detail"].as_str().unwrap_or("")
                ));
            }
        } else if let Ok(list) = reg.list_skills() {
            for sk in list.iter().take(8) {
                out.push(format!(
                    "  {} ({}t fm / {}t body) — {}",
                    sk.name,
                    sk.frontmatter_tokens,
                    sk.body_tokens,
                    truncate_chars(&sk.description, 52)
                ));
            }
        }
        return out;
    }

    let mut split = trimmed.splitn(2, char::is_whitespace);
    let sub = split.next().unwrap_or("");
    let rest = split.next().unwrap_or("").trim();

    if sub.eq_ignore_ascii_case("pipelines") {
        let pipes = reg.pipelines();
        let mut out = vec![format!("=== Pre-Wired DAG Pipelines ({}) ===", pipes.len())];
        for p in pipes.iter().take(12) {
            out.push(format!(
                "  {} [{}] — {}",
                p.id,
                p.category,
                truncate_chars(&p.title, 48)
            ));
        }
        return out;
    }
    if sub.eq_ignore_ascii_case("dag") {
        let q = if rest.is_empty() { "deep research" } else { rest };
        let dag = reg.compose_4stage_dag(q, 3);
        let mut out = vec![format!("=== 4-Stage Execution DAG: `{}` ===", truncate_chars(q, 36))];
        if let Some(stages) = dag["stages"].as_array() {
            for st in stages {
                let skills_s = st["skills"].as_array().map_or_else(String::new, |a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                });
                out.push(format!(
                    "  {} -> [{}]",
                    st["stage"].as_str().unwrap_or("-"),
                    skills_s
                ));
            }
        }
        return out;
    }
    if sub.eq_ignore_ascii_case("codify") {
        let write_disk = rest.contains("--write");
        let clean_rest = rest.replace("--write", "");
        let segs: Vec<&str> = clean_rest.split('|').map(str::trim).filter(|s| !s.is_empty()).collect();
        if segs.len() < 3 {
            return vec!["Usage: /skills codify <slug> | <Use when...> | <body> [--write]".into()];
        }
        let req = CodifySkillRequest {
            slug: segs[0].to_string(),
            description: segs[1].to_string(),
            category: "Omnia Learned Skill".to_string(),
            canonical_artifacts: Vec::new(),
            body_md: segs[2].to_string(),
            invariants_md: None,
            dry_run: !write_disk,
        };
        return match reg.codify_skill(workspace, &req) {
            Ok(val) => vec![
                format!("=== Skill Codify [dryRun={}] ===", val["dryRun"].as_bool().unwrap_or(true)),
                format!(
                    "  slug: {} | fm:{}t body:{}t | sha:{}",
                    val["slug"].as_str().unwrap_or("-"),
                    val["frontmatterTokens"].as_u64().unwrap_or(0),
                    val["bodyTokens"].as_u64().unwrap_or(0),
                    truncate_chars(val["sha256"].as_str().unwrap_or(""), 12)
                ),
            ],
            Err(e) => vec![format!("Skill codify rejected: {e}")],
        };
    }

    let query = if sub.eq_ignore_ascii_case("route") || sub.eq_ignore_ascii_case("vault") {
        if rest.is_empty() {
            return vec!["Usage: /skills route <query> | /skills vault <query>".into()];
        }
        rest
    } else {
        trimmed
    };
    let res = reg.search_with_vault(query, 6, true);
    let mut out = vec![format!(
        "=== Skill Route + Cold Vault: `{}` (active:{} vault:{}) ===",
        truncate_chars(query, 32),
        res["activeTotal"].as_u64().unwrap_or(0),
        res["vaultTotal"].as_u64().unwrap_or(0)
    )];
    if let Some(arr) = res["matches"].as_array() {
        out.push("--- Active Skills (BM25 + VN-EN) ---".into());
        if arr.is_empty() {
            out.push("  (no active skill match)".into());
        }
        for m in arr.iter().take(5) {
            out.push(format!(
                "  {} (score:{:.2}) — {}",
                m["skill"]["name"].as_str().unwrap_or("-"),
                m["score"].as_f64().unwrap_or(0.0),
                truncate_chars(m["skill"]["description"].as_str().unwrap_or(""), 48)
            ));
        }
    }
    if let Some(varr) = res["vaultMatches"].as_array() {
        if !varr.is_empty() {
            out.push("--- Cold Vault Matches (1,001 Catalog) ---".into());
            for vm in varr.iter().take(5) {
                out.push(format!(
                    "  {} [{}] (score:{:.2}) — {}",
                    vm["entry"]["slug"].as_str().unwrap_or("-"),
                    vm["entry"]["category"].as_str().unwrap_or("-"),
                    vm["score"].as_f64().unwrap_or(0.0),
                    truncate_chars(vm["entry"]["focus"].as_str().unwrap_or(""), 44)
                ));
            }
        }
    }
    out
}

fn format_lifecycle_drawer_snapshot(os: &ArtifactOs, skills: &SkillRegistry) -> Vec<String> {
    let mut out = vec!["=== 12-Artifact Proactive Lifecycle ===".into()];
    if let Ok(st) = os.super_state() {
        out.push(format!(
            "Phase: {} | Wave: {} | Strikes: {}",
            st.phase, st.wave, st.strike_count
        ));
        out.push(format!(
            "Todos Open: {} | DoD Verified: {}/{}",
            st.open_todos, st.verified_dod_gates, st.total_dod_gates
        ));
    }
    let all = os.list_artifacts(None, None).unwrap_or_default();
    let mut verified_rcpts = 0usize;
    let mut counts = [0usize; 12];
    for art in &all {
        if let Some(idx) = ArtifactKind::ALL.iter().position(|k| *k == art.kind) {
            counts[idx] += 1;
        }
        if art
            .receipt
            .as_ref()
            .is_some_and(|r| !r.verified.is_empty())
        {
            verified_rcpts += 1;
        }
    }
    out.push(format!(
        "Artifacts: {} total | 6-State Verified: {}",
        all.len(),
        verified_rcpts
    ));
    out.push(format!(
        "  Goal:{} Spec:{} Blueprint:{} Plan:{}",
        counts[0], counts[1], counts[2], counts[3]
    ));
    out.push(format!(
        "  Todo:{} Progress:{} DoD:{} Ckpt:{}",
        counts[4], counts[5], counts[6], counts[7]
    ));
    out.push(format!(
        "  Handoff:{} Mem:{} Lesson:{} Skill:{}",
        counts[8], counts[9], counts[10], counts[11]
    ));
    let lessons = os.list_lessons(None).unwrap_or_default();
    let proj_l = lessons.iter().filter(|l| l.scope == "project").count();
    let glob_l = lessons.iter().filter(|l| l.scope == "global").count();
    out.push(format!("Lessons: {proj_l} project / {glob_l} global"));
    let doc = skills.doctor();
    out.push("--- Skills & Cold Vault ---".into());
    out.push(format!(
        "Active: {} | Cold Vault: {} | ~{} tok",
        doc.total_skills, doc.cold_vault_count, doc.startup_tokens_est
    ));
    out.push(format!(
        "Merkle: {} | ok: {}",
        truncate_chars(&doc.merkle_root_sha256, 16),
        doc.ok
    ));
    out
}

fn refresh_research_drawer(state: &mut TuiAppState) {
    match (open_research_vault(&state.workspace), open_deep_think()) {
        (Ok(vault), Ok(think)) => {
            state.last_research_summary = format_research_drawer_snapshot(&vault, &think);
        }
        (Ok(vault), Err(_)) => {
            state.last_research_summary = format_sources_ledger_lines(&vault, None);
        }
        (Err(e), _) => {
            state.last_research_summary = vec![format!("ResearchVault unavailable: {e}")];
        }
    }
}

fn refresh_lifecycle_drawer(state: &mut TuiAppState) {
    let ws = state.workspace.clone();
    match open_artifact_os(&ws) {
        Ok(os) => {
            let reg = state.ensure_skill_registry();
            state.last_lifecycle_summary = format_lifecycle_drawer_snapshot(&os, reg);
        }
        Err(e) => {
            state.last_lifecycle_summary = vec![format!("ArtifactOs unavailable: {e}")];
        }
    }
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
    let approval_mode = resolve_tui_approval_mode(opts.approval_mode, saved.approval_mode.as_deref());

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
    let init_focus = saved
        .focus_mode
        .as_deref()
        .and_then(TuiFocusMode::parse)
        .unwrap_or_default();
    let init_persona = saved
        .persona
        .as_deref()
        .and_then(find_builtin_persona)
        .map(|p| p.slug.to_string());
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
                text: format!(
                    "Omnia Pure-Rust Super-Harness v{} ready [{} | {} | {}]. Type a prompt or /help.",
                    env!("CARGO_PKG_VERSION"),
                    format_approval_badge(approval_mode),
                    init_focus.pill(),
                    format_persona_pill(init_persona.as_deref())
                ),
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
        last_research_summary: Vec::new(),
        last_lifecycle_summary: Vec::new(),
        skill_registry: None,
        focus_mode: init_focus,
        active_persona: init_persona,
        forked_threads: Vec::new(),
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
                UiAsyncEvent::ResearchCompleted {
                    query,
                    transcript_lines,
                    drawer_lines,
                } => {
                    state.last_research_summary = drawer_lines;
                    state.push_line(
                        TranscriptEntryKind::System,
                        format!("── Research complete: {} ──", truncate_chars(&query, 56)),
                    );
                    for l in transcript_lines {
                        state.push_line(TranscriptEntryKind::System, l);
                    }
                }
                UiAsyncEvent::ArenaCompleted { prompt, results } => {
                    let lines = format_arena_results_lines(&prompt, &results);
                    state.last_research_summary = lines.clone();
                    state.drawer_tab = DrawerTab::Research;
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
                                if state.drawer_tab == DrawerTab::Research
                                    && state.last_research_summary.is_empty()
                                {
                                    refresh_research_drawer(&mut state);
                                } else if state.drawer_tab == DrawerTab::Lifecycle
                                    && state.last_lifecycle_summary.is_empty()
                                {
                                    refresh_lifecycle_drawer(&mut state);
                                }
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
                                let effective_prompt = compose_prompt_with_focus_and_persona(
                                    &submitted,
                                    state.focus_mode,
                                    state.active_persona.as_deref(),
                                );
                                let t0 = Instant::now();
                                tokio::spawn(async move {
                                    let sink_tx = tx_clone.clone();
                                    let sink: HarnessEventSink = Arc::new(move |ev| {
                                        let _ = sink_tx.send(UiAsyncEvent::Harness(ev));
                                    });
                                    let res = eng.run_prompt(&effective_prompt, max_turns, timeout_secs, Some(sink)).await;
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
        for alias in [
            "yolo",
            "turbo",
            "full-access",
            "full",
            "unrestricted",
            "auto",
            "auto-approve",
            " YOLO ",
            "Full-Access",
        ] {
            assert_eq!(
                parse_approval(alias),
                Some(ApprovalMode::Yolo),
                "expected YOLO for alias `{alias}`"
            );
        }
        assert_eq!(parse_approval("write"), Some(ApprovalMode::Write));
        assert_eq!(parse_approval("plan"), Some(ApprovalMode::Plan));
        assert_eq!(parse_approval("read-only"), Some(ApprovalMode::Plan));
        assert_eq!(parse_approval("ask"), Some(ApprovalMode::AlwaysAsk));
        assert_eq!(parse_approval("always-ask"), Some(ApprovalMode::AlwaysAsk));
        assert_eq!(
            parse_approval("always-ask-cached"),
            Some(ApprovalMode::AlwaysAskCached)
        );
        assert_eq!(parse_approval("bad"), None);

        // Steer #22: bare TUI defaults to YOLO (full auto-approve) with crisp YOLO · AUTO badge.
        assert_eq!(resolve_tui_approval_mode(None, None), ApprovalMode::Yolo);
        assert_eq!(
            resolve_tui_approval_mode(None, Some("turbo")),
            ApprovalMode::Yolo
        );
        assert_eq!(
            resolve_tui_approval_mode(None, Some("plan")),
            ApprovalMode::Plan
        );
        assert_eq!(
            resolve_tui_approval_mode(Some(ApprovalMode::AlwaysAsk), Some("yolo")),
            ApprovalMode::AlwaysAsk
        );
        assert_eq!(format_approval_badge(ApprovalMode::Yolo), "YOLO · AUTO");
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

    #[test]
    fn steer18_20_slash_commands_drawer_tabs_and_wcag_themes_are_wired() {
        let cmds: Vec<&str> = SLASH_DEFS.iter().map(|d| d.cmd).collect();
        for req in [
            "/research",
            "/sources",
            "/rag",
            "/think",
            "/goal",
            "/spec",
            "/blueprint",
            "/plan",
            "/todo",
            "/progress",
            "/dod",
            "/handoff",
            "/learn",
            "/lessons",
            "/skills",
        ] {
            assert!(cmds.contains(&req), "missing Steer #18-20 slash command {req}");
        }

        // Verify full 10-state F4 drawer cycle including Research and Lifecycle.
        let mut tab = DrawerTab::Closed;
        let mut visited = Vec::new();
        for _ in 0..10 {
            tab = tab.next();
            visited.push(tab);
        }
        assert_eq!(
            visited,
            vec![
                DrawerTab::Status,
                DrawerTab::Network,
                DrawerTab::Router,
                DrawerTab::Cache,
                DrawerTab::Swarm,
                DrawerTab::Memory,
                DrawerTab::Research,
                DrawerTab::Lifecycle,
                DrawerTab::Rewind,
                DrawerTab::Closed,
            ]
        );
        assert_eq!(DrawerTab::Research.title(), "Research & Deep Think");
        assert_eq!(DrawerTab::Lifecycle.title(), "12-Artifact Lifecycle");

        for theme in [
            TuiTheme::Obsidian,
            TuiTheme::Titanium,
            TuiTheme::Alabaster,
            TuiTheme::Blueprint,
        ] {
            assert_eq!(TuiTheme::parse(theme.as_str()), Some(theme));
            assert_ne!(theme.hud_fg(), theme.hud_bg());
            assert!(matches!(
                theme.drawer_fg(),
                Color::Gray | Color::White | Color::Black
            ));
        }

        let (q, scope, tier, fetch, offline) =
            parse_research_args("--scope academic --global --no-fetch --offline rust wal");
        assert_eq!(q, "rust wal");
        assert_eq!(scope, WebSearchScope::Academic);
        assert_eq!(tier, VaultTier::Global);
        assert!(!fetch);
        assert!(offline);
    }

    #[test]
    fn tui_research_sources_rag_think_and_privacy_mask_work_end_to_end() {
        let vault = ResearchVault::open_in_memory().unwrap();
        let s1 = vault
            .ingest_document(
                VaultTier::Local,
                "https://docs.example.test/wal-leases",
                None,
                Some("Cooperative WAL Leases"),
                "# WAL\nOmnia enforces WAL cooperative leases with 203.0.113.42 telemetry.",
                "text/markdown",
                Some(200),
                "wal leases",
            )
            .unwrap();
        assert_eq!(s1.citation_id, "S001");

        let blocked = vault
            .record_fetch_failure(
                VaultTier::Local,
                "https://gated.example.test/challenge",
                Some(403),
                omnia_harness::research_vault::FetchErrorKind::PlatformBlocked,
                "Cloudflare Turnstile active",
                "wal leases",
            )
            .unwrap();
        assert_eq!(blocked.citation_id, "S002");

        let ledger_lines = format_sources_ledger_lines(&vault, None);
        let joined_ledger = ledger_lines.join("\n");
        assert!(joined_ledger.contains("Sources (Searched, Viewed & Extracted)"));
        assert!(joined_ledger.contains("[S001]"));
        assert!(joined_ledger.contains("[BLOCKED_BY_CHALLENGE]"));

        let rag_lines = execute_rag_command(&vault, "cooperative wal leases");
        assert!(rag_lines.iter().any(|l| l.contains("[S001]")));

        let pin_lines = execute_rag_command(&vault, "pin S001 global");
        assert!(pin_lines.iter().any(|l| l.contains("[G001]") && l.contains("global")));

        let dt = DeepThinkEngine::open_in_memory().unwrap();
        let start_out = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            "Choose zero-bloat RAG storage",
        );
        let sessions = dt.list_sessions(None, 4).unwrap();
        assert_eq!(sessions.len(), 1);
        let tid = sessions[0].think_id.clone();
        assert!(start_out.iter().any(|l| l.contains(&tid)));

        let _ = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("branch {tid} baseline Flat JSON | Easy but slow"),
        );
        let _ = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("branch {tid} sota SQLite WAL | Fast concurrent reads"),
        );
        let _ = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("branch {tid} contrarian In-memory only | Zero disk persistence"),
        );
        let fals_out = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("falsify {tid} br_2 pass cargo-test | 100% pass"),
        );
        assert!(fals_out.iter().any(|l| l.contains("Verified") && l.contains("PASS")));

        let rt_out = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("redteam {tid} gpt-6.2-sol Verify AV lock retry on Windows"),
        );
        assert!(rt_out.iter().any(|l| l.contains("distinct_family=true")));

        let done_out = execute_think_command(
            &dt,
            "tui-test",
            "claude-sonnet-5-5",
            "max",
            &format!("conclude {tid} br_2 Selected SQLite WAL [S001]"),
        );
        assert!(done_out.iter().any(|l| l.contains("Rejected Alternatives: 2")));

        let drawer = format_research_drawer_snapshot(&vault, &dt);
        let drawer_text = drawer.join("\n");
        assert!(drawer_text.contains("Sources (Searched, Viewed & Extracted)"));
        assert!(drawer_text.contains(&tid));

        // Verify Privacy Mask strips IP/email from drawer lines cleanly.
        let masked_sample = PrivacyMask::mask_text("Source 203.0.113.42 owner@example.test");
        assert!(!masked_sample.contains("203.0.113.42"));
        assert!(!masked_sample.contains("owner@example.test"));
    }

    #[test]
    fn tui_12_artifact_lifecycle_handoff_lessons_and_skills_work_end_to_end() {
        let ws = Path::new(".");
        let os = ArtifactOs::open_in_memory(ws).unwrap();

        for (kind, spec) in [
            (ArtifactKind::Goal, "set Ship Steer 18-20 | Deliver [[spec_tui]] cleanly"),
            (ArtifactKind::Spec, "set TUI Cockpit Spec | AC-1 all 15 commands work"),
            (ArtifactKind::Blueprint, "set TUI Drawer Blueprint | Research and Lifecycle tabs"),
            (ArtifactKind::Plan, "set Rollout Plan | Implement and test in memory"),
        ] {
            let out = execute_lifecycle_artifact_command(&os, ws, kind, spec);
            assert!(out.iter().any(|l| l.contains("Verify: ok=true")));
        }

        let todo_add = execute_todo_command(&os, "add Verify TUI unit tests");
        let todo_id = os.list_artifacts(Some(ArtifactKind::Todo), None).unwrap()[0].id.clone();
        assert!(todo_add.iter().any(|l| l.contains(&todo_id)));
        let todo_done = execute_todo_command(&os, &format!("done {todo_id} cargo test PASS"));
        assert!(todo_done.iter().any(|l| l.contains("[done]") && l.contains("V:1")));

        let dod_add = execute_dod_command(&os, "add All TUI tests pass");
        let dod_id = os.list_artifacts(Some(ArtifactKind::Dod), None).unwrap()[0].id.clone();
        assert!(dod_add.iter().any(|l| l.contains(&dod_id)));
        // Receipt-gated DoD refuses empty verified evidence.
        let dod_reject = execute_dod_command(&os, &format!("pass {dod_id}"));
        assert!(dod_reject.iter().any(|l| l.contains("rejected")));
        let dod_pass = execute_dod_command(&os, &format!("pass {dod_id} cargo test -p omnia-cli PASS"));
        assert!(dod_pass.iter().any(|l| l.contains("[verified]") && l.contains("V:1")));

        let prog = execute_progress_command(&os, "phase verifying 2");
        assert!(prog.iter().any(|l| l.contains("phase:verifying wave:2")));

        let h1 = execute_handoff_command(
            &os,
            ws,
            "write Handoff 1 | Body 1\n<!-- AGENT_NOTES_START -->\nKeep TUI note\n<!-- AGENT_NOTES_END -->",
        );
        assert!(h1.iter().any(|l| l.contains("AGENT_NOTES preserved")));
        let _ = execute_handoff_command(&os, ws, "write Handoff 2 | Body 2");
        let latest_h = os.list_artifacts(Some(ArtifactKind::Handoff), None).unwrap();
        assert!(latest_h[0].body_md.contains("Keep TUI note"));

        let l1 = execute_learn_command(
            &os,
            "Never slice UTF-8 by bytes | Multi-byte Vietnamese panics | Use char-aware truncate_chars | project",
        );
        assert!(l1.iter().any(|l| l.contains("Lesson Captured")));
        let l2 = execute_learn_command(
            &os,
            "Never slice UTF-8 by bytes | Multi-byte Vietnamese panics | Use char-aware truncate_chars | global",
        );
        assert!(l2.iter().any(|l| l.contains("[OVERLAP]")));
        let listed = execute_lessons_command(&os, "");
        assert!(listed.iter().any(|l| l.contains("2-Tier Lessons (2")));

        let reg = SkillRegistry::new();
        let pipelines = execute_skills_command(&reg, ws, "pipelines");
        assert!(pipelines.iter().any(|l| l.contains("Pre-Wired DAG Pipelines (24)")));
        let dag = execute_skills_command(&reg, ws, "dag nghien cuu tai lieu");
        assert!(dag.iter().any(|l| l.contains("stage_1_preflight_framing")));
        assert!(dag.iter().any(|l| l.contains("stage_4_receipt_handoff")));
        let dry_codify = execute_skills_command(
            &reg,
            ws,
            "codify tui-demo-skill | Use when verifying TUI codify dry-run | # Body\nRun checks.",
        );
        assert!(dry_codify.iter().any(|l| l.contains("dryRun=true")));

        let drawer = format_lifecycle_drawer_snapshot(&os, &reg);
        let dtext = drawer.join("\n");
        assert!(dtext.contains("12-Artifact Proactive Lifecycle"));
        assert!(dtext.contains("DoD Verified: 1/1"));
        assert!(dtext.contains("Lessons: 1 project / 1 global"));
    }

    #[test]
    fn steer23_arena_persona_focus_fork_and_hud_pills_work() {
        let cmds: Vec<&str> = SLASH_DEFS.iter().map(|d| d.cmd).collect();
        for req in ["/arena", "/persona", "/focus", "/fork"] {
            assert!(cmds.contains(&req), "missing Steer #23 slash command {req}");
        }

        // Focus Mode parser & pills
        assert_eq!(TuiFocusMode::parse("web"), Some(TuiFocusMode::Web));
        assert_eq!(TuiFocusMode::parse("academic"), Some(TuiFocusMode::Academic));
        assert_eq!(TuiFocusMode::parse("code"), Some(TuiFocusMode::Code));
        assert_eq!(TuiFocusMode::parse("rag"), Some(TuiFocusMode::Rag));
        assert_eq!(TuiFocusMode::parse("deep"), Some(TuiFocusMode::Deep));
        assert_eq!(TuiFocusMode::parse("unknown-mode"), None);
        assert_eq!(TuiFocusMode::Web.pill(), "FOCUS:WEB");
        assert_eq!(TuiFocusMode::Deep.pill(), "FOCUS:DEEP");

        // Builtin Personas / Omnia Gems & HUD pill formatting
        assert_eq!(format_persona_pill(None), "GEM:STD");
        let arch = find_builtin_persona("Principal Architect").expect("architect gem");
        assert_eq!(arch.slug, "architect");
        assert_eq!(format_persona_pill(Some(arch.slug)), "GEM:ARC");
        let res = find_builtin_persona("researcher").expect("researcher gem");
        assert_eq!(res.focus, TuiFocusMode::Deep);
        assert_eq!(format_persona_pill(Some(res.slug)), "GEM:RES");
        assert!(find_builtin_persona("reviewer").is_some());
        assert!(find_builtin_persona("math").is_some());
        let plist = format_persona_list_lines(Some("researcher")).join("\n");
        assert!(plist.contains("Deep Researcher"));
        assert!(plist.contains("GEM:RES"));

        // Focus + Persona prompt composition leaves default Code/none untouched
        assert_eq!(
            compose_prompt_with_focus_and_persona("hello", TuiFocusMode::Code, None),
            "hello"
        );
        let composed = compose_prompt_with_focus_and_persona(
            "Compare WAL",
            TuiFocusMode::Academic,
            Some("math"),
        );
        assert!(composed.contains("Focus=Academic"));
        assert!(composed.contains("Math & Proof Lab"));
        assert!(composed.ends_with("Compare WAL"));

        // Arena parser (2..=4 models + dedup + error bounds) & formatter
        let (models, prompt) =
            parse_arena_args("claude-sonnet-5-5,gpt-6.2-sol,gpt-6.2-sol Compare Rust WAL")
                .expect("valid arena args");
        assert_eq!(models, vec!["claude-sonnet-5-5", "gpt-6.2-sol"]);
        assert_eq!(prompt, "Compare Rust WAL");
        assert!(parse_arena_args("only-one-model hello").is_err());
        assert!(parse_arena_args("m1,m2,m3,m4,m5 too many").is_err());
        assert!(parse_arena_args("m1,m2").is_err());

        let arena_lines = format_arena_results_lines(
            "Compare WAL",
            &[
                ArenaModelOutcome {
                    model: "claude-sonnet-5-5".into(),
                    status: "unconfigured_provider".into(),
                    elapsed_ms: 0,
                    output_tokens: 0,
                    tps: 0.0,
                    cost_usd: 0.0,
                    preview: "No API key configured".into(),
                },
                ArenaModelOutcome {
                    model: "gpt-6.2-sol".into(),
                    status: "ok".into(),
                    elapsed_ms: 412,
                    output_tokens: 120,
                    tps: 84.5,
                    cost_usd: 0.001234,
                    preview: "WAL enables concurrent readers.".into(),
                },
            ],
        )
        .join("\n");
        assert!(arena_lines.contains("Arena Compare (2 models)"));
        assert!(arena_lines.contains("unconfigured_provider"));
        assert!(arena_lines.contains("$0.001234"));

        // Fork thread snapshot & list formatting
        let sample_tx = vec![TranscriptLine {
            kind: TranscriptEntryKind::User,
            text: "Inspect WAL".into(),
        }];
        let fork1 = create_fork_snapshot(
            1,
            "alt-branch",
            "tui-root-1",
            "claude-sonnet-5-5",
            TuiFocusMode::Deep,
            Some("architect"),
            &sample_tx,
        );
        assert_eq!(fork1.branch_id, "fork-1");
        assert_eq!(fork1.label, "alt-branch");
        assert_eq!(fork1.transcript.len(), 1);
        let flist = format_fork_list_lines(&[fork1]).join("\n");
        assert!(flist.contains("fork-1"));
        assert!(flist.contains("FOCUS:DEEP"));
        assert!(flist.contains("GEM:ARC"));
    }
}
