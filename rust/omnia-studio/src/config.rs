//! Studio server configuration, environment defaults, and CLI parsing.

use std::env;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::{Host, Url};

/// Default loopback host for Omnia Studio.
pub const DEFAULT_HOST: &str = "127.0.0.1";
/// Default TCP port for Omnia Studio (`http://127.0.0.1:8787`).
pub const DEFAULT_PORT: u16 = 8787;
/// Default upstream `omnia-runtime` port (`http://127.0.0.1:8790`).
pub const DEFAULT_RUNTIME_PORT: u16 = 8790;
/// Default upstream `omnia-runtime` base URL.
pub const DEFAULT_RUNTIME_URL: &str = "http://127.0.0.1:8790";
/// Bounded upstream runtime timeout enforced on all proxy requests (3,000 ms).
pub const RUNTIME_PROXY_TIMEOUT_MS: u64 = 3_000;
/// Default externalized rollback directory (strictly outside tracked source checkout).
pub const DEFAULT_ROLLBACK_ROOT: &str = r"D:\OmniaData\rollback\studio";

/// Parsed CLI outcome from [`StudioConfig::parse_args`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliAction {
    /// Start the Studio HTTP server indefinitely until Ctrl+C.
    Run(StudioConfig),
    /// Start on configured/ephemeral port, execute bounded self-smoke check, and exit.
    Smoke(StudioConfig),
    /// Print CLI help and exit cleanly.
    Help(String),
}

/// Configuration for the Omnia Studio HTTP/JSON-RPC host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudioConfig {
    /// Loopback host address to bind (`127.0.0.1`, `localhost`, or `[::1]` / `::1`).
    pub host: String,
    /// Loopback TCP port (`0` binds an OS-assigned ephemeral port).
    pub port: u16,
    /// Repository / workspace root directory.
    pub workspace_root: PathBuf,
    /// Static UI directory (`ui/` containing `index.html`, `styles/`, `app/`).
    pub ui_root: PathBuf,
    /// Directory containing `.agents/skills` (or `skills/`).
    pub skills_root: PathBuf,
    /// Optional SQLite database path; `None` uses in-memory `SessionStore`.
    pub db_path: Option<PathBuf>,
    /// Optional upstream `omnia-runtime` base URL (`http://127.0.0.1:8790`).
    pub runtime_url: Option<String>,
    /// Upstream runtime timeout (defaults to `3,000 ms`).
    pub runtime_timeout: Duration,
    /// Optional external history store root directory containing `history-active.json`.
    pub history_root: Option<PathBuf>,
    /// Optional explicit immutable active history pointer (`omnia.history-active.v1`).
    pub history_pointer: Option<PathBuf>,
    /// Optional legacy/direct history manifest path (`omnia.history-manifest.v2`).
    pub history_manifest: Option<PathBuf>,
    /// External rollback directory for workspace mutation receipts (never inside workspace).
    pub rollback_root: PathBuf,
    /// Optional Edge app-window launch hint (accepted for C++ CLI parity).
    pub open_window: bool,
    /// Smoke-test mode (bind, self-probe `/api/health` and `/api/capabilities`, exit).
    pub smoke: bool,
}

impl Default for StudioConfig {
    fn default() -> Self {
        let workspace_root = discover_workspace_root();
        let ui_root = workspace_root.join("ui");
        let skills_root = workspace_root.join(".agents").join("skills");
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            workspace_root,
            ui_root,
            skills_root,
            db_path: None,
            runtime_url: None,
            runtime_timeout: Duration::from_millis(RUNTIME_PROXY_TIMEOUT_MS),
            history_root: None,
            history_pointer: None,
            history_manifest: None,
            rollback_root: PathBuf::from(DEFAULT_ROLLBACK_ROOT),
            open_window: false,
            smoke: false,
        }
    }
}

impl StudioConfig {
    /// Constructs configuration from `OMNIA_STUDIO_*` (and compatible `OMNIA_*`) env vars.
    #[must_use]
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        let mut ui_overridden = false;
        let mut skills_overridden = false;

        if let Some(host) = non_empty_env("OMNIA_STUDIO_HOST") {
            cfg.host = host;
        }
        if let Some(port) = non_empty_env("OMNIA_STUDIO_PORT").and_then(|v| v.parse::<u16>().ok()) {
            cfg.port = port;
        }
        if let Some(ws) = non_empty_env("OMNIA_STUDIO_WORKSPACE_ROOT")
            .or_else(|| non_empty_env("OMNIA_WORKSPACE_ROOT"))
        {
            cfg.workspace_root = PathBuf::from(ws);
        }
        if let Some(ui) = non_empty_env("OMNIA_STUDIO_UI_ROOT") {
            cfg.ui_root = PathBuf::from(ui);
            ui_overridden = true;
        }
        if let Some(skills) =
            non_empty_env("OMNIA_STUDIO_SKILLS_ROOT").or_else(|| non_empty_env("OMNIA_SKILLS_ROOT"))
        {
            cfg.skills_root = PathBuf::from(skills);
            skills_overridden = true;
        }
        if !ui_overridden {
            cfg.ui_root = cfg.workspace_root.join("ui");
        }
        if !skills_overridden {
            cfg.skills_root = cfg.workspace_root.join(".agents").join("skills");
        }
        if let Some(db) = non_empty_env("OMNIA_STUDIO_DB") {
            cfg.db_path = Some(PathBuf::from(db));
        }

        cfg.runtime_url = Some(DEFAULT_RUNTIME_URL.to_string());
        if let Ok(rt_url) = env::var("OMNIA_STUDIO_RUNTIME_URL") {
            cfg.runtime_url = normalize_optional_runtime_url(&rt_url);
        } else if let Some(rt_port) = non_empty_env("OMNIA_STUDIO_RUNTIME_PORT")
            .or_else(|| non_empty_env("OMNIA_RUNTIME_PORT"))
            .and_then(|v| v.parse::<u16>().ok())
        {
            cfg.runtime_url = if rt_port == 0 {
                None
            } else {
                Some(format!("http://127.0.0.1:{rt_port}"))
            };
        }

        if let Some(root) = non_empty_env("OMNIA_STUDIO_HISTORY_ROOT")
            .or_else(|| non_empty_env("OMNIA_HISTORY_ROOT"))
        {
            cfg.history_root = Some(PathBuf::from(root));
        }
        if let Some(ptr) = non_empty_env("OMNIA_STUDIO_HISTORY_POINTER")
            .or_else(|| non_empty_env("OMNIA_HISTORY_POINTER"))
        {
            cfg.history_pointer = Some(PathBuf::from(ptr));
        }
        if let Some(man) = non_empty_env("OMNIA_STUDIO_HISTORY_MANIFEST")
            .or_else(|| non_empty_env("OMNIA_HISTORY_MANIFEST"))
        {
            cfg.history_manifest = Some(PathBuf::from(man));
        }
        if let Some(rb) = non_empty_env("OMNIA_STUDIO_ROLLBACK_ROOT") {
            cfg.rollback_root = PathBuf::from(rb);
        }
        cfg
    }

    /// Parses CLI flags over [`StudioConfig::from_env`], maintaining C++ `omnia_studio` parity.
    pub fn parse_args<I, S>(args: I) -> Result<CliAction, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut cfg = Self::from_env();
        let mut ui_explicit = non_empty_env("OMNIA_STUDIO_UI_ROOT").is_some();
        let mut skills_explicit = non_empty_env("OMNIA_STUDIO_SKILLS_ROOT")
            .or_else(|| non_empty_env("OMNIA_SKILLS_ROOT"))
            .is_some();

        let raw_args: Vec<String> = args.into_iter().map(Into::into).collect();
        let mut idx = 0usize;
        while idx < raw_args.len() {
            let flag = raw_args[idx].as_str();
            match flag {
                "-h" | "--help" => {
                    return Ok(CliAction::Help(Self::help_text()));
                }
                "--open-window" => {
                    cfg.open_window = true;
                }
                "--smoke" => {
                    cfg.smoke = true;
                }
                "--host" => {
                    idx += 1;
                    cfg.host = take_value(&raw_args, idx, "--host")?;
                }
                "--port" => {
                    idx += 1;
                    let val = take_value(&raw_args, idx, "--port")?;
                    cfg.port = val
                        .parse::<u16>()
                        .map_err(|_| format!("Invalid --port value: '{val}'"))?;
                }
                "--ui-root" => {
                    idx += 1;
                    cfg.ui_root = PathBuf::from(take_value(&raw_args, idx, "--ui-root")?);
                    ui_explicit = true;
                }
                "--skills-root" => {
                    idx += 1;
                    cfg.skills_root = PathBuf::from(take_value(&raw_args, idx, "--skills-root")?);
                    skills_explicit = true;
                }
                "--workspace-root" | "--source-root" | "--root" => {
                    idx += 1;
                    let root = PathBuf::from(take_value(&raw_args, idx, flag)?);
                    cfg.workspace_root = root;
                    if !ui_explicit {
                        cfg.ui_root = cfg.workspace_root.join("ui");
                    }
                    if !skills_explicit {
                        cfg.skills_root = cfg.workspace_root.join(".agents").join("skills");
                    }
                }
                "--db" | "--session-db" => {
                    idx += 1;
                    let val = take_value(&raw_args, idx, flag)?;
                    cfg.db_path = if val.eq_ignore_ascii_case("memory") || val == ":memory:" {
                        None
                    } else {
                        Some(PathBuf::from(val))
                    };
                }
                "--runtime-url" => {
                    idx += 1;
                    let val = take_value(&raw_args, idx, "--runtime-url")?;
                    cfg.runtime_url = normalize_optional_runtime_url(&val);
                }
                "--runtime-port" => {
                    idx += 1;
                    let val = take_value(&raw_args, idx, "--runtime-port")?;
                    let port = val
                        .parse::<u16>()
                        .map_err(|_| format!("Invalid --runtime-port value: '{val}'"))?;
                    cfg.runtime_url = if port == 0 {
                        None
                    } else {
                        Some(format!("http://127.0.0.1:{port}"))
                    };
                }
                "--history-root" => {
                    idx += 1;
                    cfg.history_root = Some(PathBuf::from(take_value(&raw_args, idx, flag)?));
                }
                "--history-pointer" => {
                    idx += 1;
                    cfg.history_pointer = Some(PathBuf::from(take_value(&raw_args, idx, flag)?));
                }
                "--history-manifest" => {
                    idx += 1;
                    cfg.history_manifest = Some(PathBuf::from(take_value(&raw_args, idx, flag)?));
                }
                "--rollback-root" => {
                    idx += 1;
                    cfg.rollback_root = PathBuf::from(take_value(&raw_args, idx, flag)?);
                }
                other => {
                    return Err(format!(
                        "Unknown CLI argument '{other}'. Run with --help for usage."
                    ));
                }
            }
            idx += 1;
        }

        cfg.validate()?;
        if cfg.smoke {
            Ok(CliAction::Smoke(cfg))
        } else {
            Ok(CliAction::Run(cfg))
        }
    }

    /// Validates bind host (loopback-only) and optional upstream runtime URL invariants.
    pub fn validate(&self) -> Result<(), String> {
        if !is_loopback_bind_host(&self.host) {
            return Err(format!(
                "Refusing non-loopback --host '{}'; Studio binds strictly on loopback (127.0.0.1, localhost, or ::1).",
                self.host
            ));
        }
        if let Some(ref rt) = self.runtime_url {
            validate_loopback_runtime_url(rt)?;
        }
        Ok(())
    }

    /// Returns a formatted bind string (`host:port`) suitable for `TcpListener::bind`.
    #[must_use]
    pub fn bind_addr(&self) -> String {
        let host = self.host.trim();
        if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]:{}", self.port)
        } else {
            format!("{host}:{}", self.port)
        }
    }

    /// Resolves the external Studio data directory (`OMNIA_HOME`, sandbox sibling of
    /// `rollback_root`, or `D:\OmniaData\studio`), strictly outside `workspace_root`.
    #[must_use]
    pub fn studio_data_dir(&self) -> PathBuf {
        if self.rollback_root != Path::new(DEFAULT_ROLLBACK_ROOT) {
            if let Some(parent) = self.rollback_root.parent() {
                return parent.join("studio-data");
            }
        }
        if let Some(home) = non_empty_env("OMNIA_HOME") {
            return PathBuf::from(home).join("studio");
        }
        #[cfg(windows)]
        {
            PathBuf::from(r"D:\OmniaData\studio")
        }
        #[cfg(not(windows))]
        {
            std::env::temp_dir().join("omnia-data").join("studio")
        }
    }

    /// Resolves the external WAL SQLite DB path for `omnia-downloader`.
    #[must_use]
    pub fn downloads_db_path(&self) -> PathBuf {
        if let Some(custom) = non_empty_env("OMNIA_DOWNLOADS_DB") {
            return PathBuf::from(custom);
        }
        self.studio_data_dir().join("downloads.db")
    }

    /// Resolves the default external download staging directory (outside `workspace_root`).
    #[must_use]
    pub fn downloads_staging_dir(&self) -> PathBuf {
        if let Some(custom) = non_empty_env("OMNIA_DOWNLOADS_STAGING") {
            return PathBuf::from(custom);
        }
        if self.rollback_root != Path::new(DEFAULT_ROLLBACK_ROOT) {
            if let Some(parent) = self.rollback_root.parent() {
                return parent.join("downloads-staging");
            }
        }
        if let Some(home) = non_empty_env("OMNIA_HOME") {
            return PathBuf::from(home).join("downloads");
        }
        #[cfg(windows)]
        {
            PathBuf::from(r"D:\OmniaData\downloads")
        }
        #[cfg(not(windows))]
        {
            std::env::temp_dir().join("omnia-data").join("downloads")
        }
    }

    /// Resolves the external WAL SQLite DB path for `omnia-notebook`.
    #[must_use]
    pub fn notebooks_db_path(&self) -> PathBuf {
        if let Some(custom) = non_empty_env("OMNIA_NOTEBOOK_DB") {
            return PathBuf::from(custom);
        }
        self.studio_data_dir().join("notebooks.db")
    }

    /// Returns static CLI usage documentation.
    #[must_use]
    pub fn help_text() -> String {
        [
            "Omnia Studio HTTP/JSON-RPC Host (Full Native Rust)",
            "",
            "Usage: omnia-studio [OPTIONS]",
            "",
            "Options:",
            "  --host <ADDR>               Loopback bind host (default: 127.0.0.1)",
            "  --port <PORT>               Loopback bind port, 0 for ephemeral (default: 8787)",
            "  --workspace-root <PATH>     Workspace root (alias: --root, --source-root)",
            "  --ui-root <PATH>            Static Flagship UI root (default: <workspace>/ui)",
            "  --skills-root <PATH>        Skills root (default: <workspace>/.agents/skills)",
            "  --db <PATH>                 SQLite WAL DB file path (default: in-memory)",
            "  --runtime-url <URL>         Upstream omnia-runtime URL (or 'none'/'off')",
            "  --runtime-port <PORT>       Upstream omnia-runtime loopback port (0 disables)",
            "  --history-root <PATH>       External redacted history root directory",
            "  --history-pointer <PATH>    Explicit omnia.history-active.v1 pointer JSON",
            "  --history-manifest <PATH>   Legacy omnia.history-manifest.v2 JSON",
            "  --rollback-root <PATH>      External rollback receipt root (default: D:\\OmniaData\\rollback\\studio)",
            "  --open-window               Edge app-window launch hint (C++ CLI compatibility)",
            "  --smoke                     Start server, verify health/capabilities, and exit cleanly",
            "  --help, -h                  Print this help text",
            "",
            "Environment variables:",
            "  OMNIA_STUDIO_HOST, OMNIA_STUDIO_PORT, OMNIA_STUDIO_WORKSPACE_ROOT,",
            "  OMNIA_STUDIO_UI_ROOT, OMNIA_STUDIO_SKILLS_ROOT, OMNIA_STUDIO_DB,",
            "  OMNIA_STUDIO_RUNTIME_URL, OMNIA_STUDIO_RUNTIME_PORT, OMNIA_STUDIO_HISTORY_ROOT,",
            "  OMNIA_STUDIO_HISTORY_POINTER, OMNIA_STUDIO_HISTORY_MANIFEST, OMNIA_STUDIO_ROLLBACK_ROOT",
        ]
        .join("\n")
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn take_value(args: &[String], idx: usize, flag: &str) -> Result<String, String> {
    args.get(idx)
        .cloned()
        .ok_or_else(|| format!("Missing value for flag '{flag}'"))
}

fn normalize_optional_runtime_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("off")
        || trimmed.eq_ignore_ascii_case("disabled")
    {
        None
    } else {
        Some(trimmed.trim_end_matches('/').to_string())
    }
}

/// Returns `true` when `host` resolves strictly to loopback (`127.0.0.1`, `localhost`, `::1`).
#[must_use]
pub fn is_loopback_bind_host(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    unbracketed
        .parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// Validates that an upstream `omnia-runtime` URL is HTTP/HTTPS on loopback with no userinfo.
pub fn validate_loopback_runtime_url(raw: &str) -> Result<Url, String> {
    let parsed =
        Url::parse(raw.trim()).map_err(|err| format!("Invalid runtime URL '{raw}': {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "Unsupported runtime URL scheme '{}'; expected http or https.",
            parsed.scheme()
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Runtime URL must not embed credentials.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Runtime URL must not contain query parameters or fragments.".to_string());
    }
    let is_loopback = match parsed.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !is_loopback {
        return Err(format!(
            "Runtime URL '{raw}' must target a loopback host (127.0.0.1, localhost, or [::1])."
        ));
    }
    Ok(parsed)
}

fn discover_workspace_root() -> PathBuf {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if looks_like_workspace_root(&cwd) {
        return cwd;
    }
    let mut cursor: Option<&Path> = cwd.parent();
    while let Some(dir) = cursor {
        if looks_like_workspace_root(dir) {
            return dir.to_path_buf();
        }
        cursor = dir.parent();
    }
    cwd
}

fn looks_like_workspace_root(dir: &Path) -> bool {
    dir.join("Cargo.toml").is_file() && dir.join("ui").join("index.html").is_file()
}
