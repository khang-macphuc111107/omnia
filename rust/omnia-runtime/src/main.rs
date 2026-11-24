mod nvidia;
mod skills;

use futures_util::StreamExt;
use omnia_connector_gateway::proxy_router::{
    FailureScope, NormalizedProxyConfig, ProxyCandidateConfig, ProxyRouter, QuotaCertainty,
    RouteSelectionRequest, RoutingStrategy,
};
use omnia_core::now_epoch_ms;
use omnia_agent::{
    read_models_config, resolve_model_endpoint, AgentStore, ApprovalMode, HarnessBackendId,
    ManagedSpawnRequest, SuperHarnessManager, WireApiMode,
};
use omnia_core::credentials::CredentialStore;
use omnia_routing::{
    normalize_provider_wire_payload, CandidateResourceState, CircuitState,
    DynamicProviderRouter, ModelCapabilities, PrivacyTier, ProviderWireDialect, QuotaState,
    RouteCandidate, RouteRequestPolicy, TaskRisk,
};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONNECTION, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::time;
use url::Url;

use nvidia::NvidiaConfig;
use skills::{QueryError, SkillCatalog};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const DEFAULT_BIND: &str = "127.0.0.1:8790";
const DEFAULT_ORIGINS: &str = "http://127.0.0.1:8787,http://localhost:8787";
const DEFAULT_MAX_BODY: usize = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 5_000;
const DEFAULT_HEADER_TIMEOUT_MS: u64 = 45_000;
const DEFAULT_TOKEN_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_RETRIES: u32 = 2;
const DEFAULT_CHAT_PATH: &str = "chat/completions";
const DEFAULT_MODELS_PATH: &str = "models";

static RUNTIME_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
struct Config {
    bind: String,
    allowed_origins: Vec<String>,
    max_body_bytes: usize,
    provider_base_url: Option<Url>,
    provider_fallback_urls: Vec<Url>,
    provider_model: Option<String>,
    provider_api_key: Option<String>,
    provider_timeout: Duration,
    provider_connect_timeout: Duration,
    provider_header_timeout: Duration,
    provider_token_timeout: Duration,
    provider_max_retries: u32,
    provider_chat_path: String,
    provider_models_path: String,
    provider_config_error: Option<String>,
    skills: SkillCatalog,
    nvidia: NvidiaConfig,
    provider_model_allowlist: Vec<String>,
}

impl Config {
    fn from_env() -> Self {
        let bind = env::var("OMNIA_RUNTIME_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
        let origins = env::var("OMNIA_RUNTIME_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| DEFAULT_ORIGINS.to_string());
        let allowed_origins = origins
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let max_body_bytes = env::var("OMNIA_RUNTIME_MAX_BODY_BYTES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MAX_BODY);
        let explicit_timeout_ms = env::var("OMNIA_PROVIDER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (100..=600_000).contains(value));
        let timeout_ms = explicit_timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let connect_timeout_ms = env::var("OMNIA_PROVIDER_CONNECT_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (100..=60_000).contains(value))
            .unwrap_or_else(|| DEFAULT_CONNECT_TIMEOUT_MS.min(timeout_ms));
        let header_timeout_ms = env::var("OMNIA_PROVIDER_HEADER_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (100..=600_000).contains(value))
            .unwrap_or_else(|| explicit_timeout_ms.unwrap_or(DEFAULT_HEADER_TIMEOUT_MS));
        let token_timeout_ms = env::var("OMNIA_PROVIDER_TOKEN_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (100..=600_000).contains(value))
            .unwrap_or_else(|| explicit_timeout_ms.unwrap_or(DEFAULT_TOKEN_TIMEOUT_MS));
        let provider_max_retries = env::var("OMNIA_PROVIDER_MAX_RETRIES")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .map(|value| value.min(5))
            .unwrap_or(DEFAULT_MAX_RETRIES);
        let provider_chat_path =
            env::var("OMNIA_PROVIDER_CHAT_PATH").unwrap_or_else(|_| DEFAULT_CHAT_PATH.to_string());
        let provider_models_path = env::var("OMNIA_PROVIDER_MODELS_PATH")
            .unwrap_or_else(|_| DEFAULT_MODELS_PATH.to_string());
        let provider_model = env::var("OMNIA_PROVIDER_MODEL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let provider_api_key = env::var("OMNIA_PROVIDER_API_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (provider_base_url, provider_config_error) = match env::var("OMNIA_PROVIDER_BASE_URL") {
            Ok(raw) => match parse_provider_url(&raw) {
                Ok(url) => (Some(url), None),
                Err(error) => (None, Some(error)),
            },
            Err(_) => (
                None,
                Some("OMNIA_PROVIDER_BASE_URL is not configured".to_string()),
            ),
        };
        let provider_fallback_urls = env::var("OMNIA_PROVIDER_FALLBACK_URLS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|raw| !raw.is_empty())
            .filter_map(|raw| parse_provider_url(raw).ok())
            .collect::<Vec<_>>();
        let skills_root = env::var("OMNIA_SKILLS_ROOT").ok();
        let skills_manifest = env::var("OMNIA_SKILLS_MANIFEST").ok();
        let skills = SkillCatalog::load(skills_root.as_deref(), skills_manifest.as_deref());
        let nvidia = NvidiaConfig::from_env();

        let allowlist_raw = env::var("OMNIA_PROVIDER_MODEL_ALLOWLIST").unwrap_or_default();
        let provider_model_allowlist = allowlist_raw
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();

        Self {
            bind,
            allowed_origins,
            max_body_bytes,
            provider_base_url,
            provider_fallback_urls,
            provider_model,
            provider_api_key,
            provider_timeout: Duration::from_millis(timeout_ms),
            provider_connect_timeout: Duration::from_millis(connect_timeout_ms),
            provider_header_timeout: Duration::from_millis(header_timeout_ms),
            provider_token_timeout: Duration::from_millis(token_timeout_ms),
            provider_max_retries,
            provider_chat_path,
            provider_models_path,
            provider_config_error,
            skills,
            nvidia,
            provider_model_allowlist,
        }
    }

    fn provider_configured(&self) -> bool {
        self.provider_base_url.is_some() && self.provider_model.is_some()
    }

    fn provider_error_detail(&self) -> &str {
        if let Some(detail) = self.provider_config_error.as_deref() {
            detail
        } else {
            "OMNIA_PROVIDER_MODEL is not configured"
        }
    }
}

#[derive(Clone)]
struct App {
    config: Config,
    client: Client,
    retry_client: Client,
    proxy_router: Arc<Mutex<ProxyRouter>>,
    candidate_urls: Arc<HashMap<String, Url>>,
    harness: Arc<SuperHarnessManager>,
    dynamic_router: Arc<DynamicProviderRouter>,
}

impl App {
    fn new(config: Config) -> Result<Self, String> {
        // Split-budget client: enforce connect_timeout only on reqwest::Client (NEVER a hard
        // wall-clock total `.timeout(...)`), so multi-minute token streams never drop mid-response.
        let client = Client::builder()
            .connect_timeout(config.provider_connect_timeout)
            .tcp_nodelay(true)
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "unable to initialize provider HTTP client".to_string())?;
        // Non-pooled client used strictly on retry attempts (`attempt >= 1`) so retries never
        // check out a potentially stalled idle keepalive or h2 socket.
        let retry_client = Client::builder()
            .connect_timeout(config.provider_connect_timeout)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| "unable to initialize provider retry HTTP client".to_string())?;

        let mut candidates = Vec::new();
        let mut candidate_urls = HashMap::new();
        if let Some(primary) = config.provider_base_url.as_ref() {
            let id = "primary-provider".to_string();
            let origin = primary.origin().ascii_serialization();
            candidate_urls.insert(id.clone(), primary.clone());
            candidates.push(ProxyCandidateConfig {
                candidate_id: id,
                provider_id: "htmustc".to_string(),
                upstream_origin: origin,
                upstream_url: primary.to_string(),
                proxy_origin: None,
                direct: true,
                env_var_ref: Some("OMNIA_PROVIDER_API_KEY".to_string()),
                route_priority: 100,
                weight: 100,
                enabled: true,
                proven: true,
                supported_models: Vec::new(),
                fallback_chain: Vec::new(),
                quota_certainty: QuotaCertainty::Unknown,
            });
        }
        for (idx, fallback) in config.provider_fallback_urls.iter().enumerate() {
            let id = format!("fallback-provider-{}", idx + 1);
            let origin = fallback.origin().ascii_serialization();
            candidate_urls.insert(id.clone(), fallback.clone());
            candidates.push(ProxyCandidateConfig {
                candidate_id: id,
                provider_id: "htmustc-fallback".to_string(),
                upstream_origin: origin,
                upstream_url: fallback.to_string(),
                proxy_origin: None,
                direct: true,
                env_var_ref: Some("OMNIA_PROVIDER_API_KEY".to_string()),
                route_priority: 50 - i32::try_from(idx).unwrap_or(0),
                weight: 50,
                enabled: true,
                proven: false,
                supported_models: Vec::new(),
                fallback_chain: Vec::new(),
                quota_certainty: QuotaCertainty::Unknown,
            });
        }
        let proxy_router = ProxyRouter::new(NormalizedProxyConfig {
            strategy: RoutingStrategy::FillFirst,
            candidates,
            trust_forwarded_headers: false,
        });

        let agent_store = AgentStore::open_in_memory()
            .map_err(|e| format!("unable to initialize agent store: {e}"))?;
        let harness = Arc::new(SuperHarnessManager::new(agent_store));
        let dynamic_router = Arc::new(DynamicProviderRouter::new());
        seed_configured_models_router(&dynamic_router, &config);

        Ok(Self {
            config,
            client,
            retry_client,
            proxy_router: Arc::new(Mutex::new(proxy_router)),
            candidate_urls: Arc::new(candidate_urls),
            harness,
            dynamic_router,
        })
    }

    fn select_candidate_for_attempt(
        &self,
        model: &str,
        attempt: u32,
        excluded: &[String],
    ) -> Option<(String, Url)> {
        let now_ms = u64::try_from(now_epoch_ms()).unwrap_or(0);
        let req_id = format!(
            "rt-{}",
            RUNTIME_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        if let Ok(mut router) = self.proxy_router.lock() {
            let sel_req = RouteSelectionRequest {
                request_id: req_id,
                model: model.to_string(),
                attempt_number: attempt,
                excluded_candidates: excluded.to_vec(),
                request_headers: BTreeMap::new(),
            };
            if let Ok(receipt) = router.select_route(&sel_req, now_ms) {
                if let Some(url) = self.candidate_urls.get(&receipt.selected_candidate_id) {
                    return Some((receipt.selected_candidate_id, url.clone()));
                }
            }
        }
        self.config
            .provider_base_url
            .as_ref()
            .map(|url| ("primary-provider".to_string(), url.clone()))
    }

    fn record_candidate_outcome(
        &self,
        candidate_id: &str,
        model: &str,
        status: u16,
        retry_after_ms: Option<u64>,
        scope: FailureScope,
    ) {
        let now_ms = u64::try_from(now_epoch_ms()).unwrap_or(0);
        if let Ok(mut router) = self.proxy_router.lock() {
            router.record_outcome(candidate_id, model, status, retry_after_ms, scope, now_ms);
        }
    }
}

fn parse_loopback_bind(raw: &str) -> Result<SocketAddr, String> {
    let address = SocketAddr::from_str(raw.trim())
        .map_err(|_| "OMNIA_RUNTIME_BIND must be a numeric socket address".to_string())?;
    let loopback = match address.ip() {
        IpAddr::V4(ip) => ip == Ipv4Addr::new(127, 0, 0, 1),
        IpAddr::V6(ip) => ip == Ipv6Addr::LOCALHOST,
    };
    if !loopback {
        return Err("OMNIA_RUNTIME_BIND must use 127.0.0.1 or ::1".to_string());
    }
    Ok(address)
}

fn parse_provider_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim())
        .map_err(|_| "OMNIA_PROVIDER_BASE_URL is not a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("OMNIA_PROVIDER_BASE_URL must use http or https".to_string());
    }
    if url.host_str().is_none() {
        return Err("OMNIA_PROVIDER_BASE_URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("OMNIA_PROVIDER_BASE_URL must not include userinfo".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("OMNIA_PROVIDER_BASE_URL must not include query or fragment".to_string());
    }
    Ok(url)
}

fn endpoint(base: &Url, suffix: &str) -> Result<Url, String> {
    let trimmed = suffix.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("provider endpoint path is empty".to_string());
    }
    if trimmed.contains('?') || trimmed.contains('#') || trimmed.contains('\0') {
        return Err(
            "provider endpoint path must not contain query, fragment, or control data".to_string(),
        );
    }
    let mut url = base.clone();
    let base_path = base.path().trim_end_matches('/');
    let path = if base_path.is_empty() {
        format!("/{trimmed}")
    } else {
        format!("{base_path}/{trimmed}")
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn valid_port(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u16>().map(|port| port > 0).unwrap_or(false)
}

fn validate_host_header(value: &str) -> Result<(), String> {
    let host = value.trim();
    if host.is_empty() || host.contains(',') || host.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err("Host header is malformed".to_string());
    }

    if let Some(rest) = host.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| "Host header is malformed".to_string())?;
        let address = &rest[..end];
        let port = &rest[end + 1..];
        if address != "::1" {
            return Err("Host header is not loopback".to_string());
        }
        if !port.is_empty() && (!port.starts_with(':') || !valid_port(&port[1..])) {
            return Err("Host header port is malformed".to_string());
        }
        return Ok(());
    }

    if host == "::1" {
        return Ok(());
    }

    let (name, port) = match host.split_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    if let Some(port) = port {
        if !valid_port(port) {
            return Err("Host header port is malformed".to_string());
        }
    }
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1"
    ) {
        Ok(())
    } else {
        Err("Host header is not loopback".to_string())
    }
}

fn validate_origin(origin: Option<&str>, allowed_origins: &[String]) -> Result<(), String> {
    let Some(origin) = origin else {
        return Ok(());
    };
    let origin = origin.trim();
    if origin.is_empty() {
        return Err("Origin header is empty".to_string());
    }
    if allowed_origins.iter().any(|allowed| allowed == origin) {
        Ok(())
    } else {
        Err("Origin is not allowed".to_string())
    }
}

fn compact_header_name(value: &str) -> String {
    value
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .map(|byte| byte.to_ascii_lowercase() as char)
        .collect()
}

fn is_credential_name(value: &str) -> bool {
    let normalized = compact_header_name(value);
    matches!(
        normalized.as_str(),
        "authorization"
            | "apikey"
            | "accesstoken"
            | "bearer"
            | "password"
            | "secret"
            | "token"
            | "credential"
            | "proxyauthorization"
            | "setcookie"
    ) || normalized.contains("authorization")
        || normalized.contains("apikey")
        || normalized.contains("accesstoken")
        || normalized.ends_with("token")
        || normalized.ends_with("secret")
        || normalized.ends_with("password")
}

fn is_proxy_config_container_key(key: &str) -> bool {
    let normalized = compact_header_name(key);
    matches!(
        normalized.as_str(),
        "options" | "provider" | "auth" | "headers" | "config" | "client" | "credentials" | "connection"
    )
}

fn contains_credential_field_recursive(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            is_credential_name(key) || contains_credential_field_recursive(value)
        }),
        Value::Array(values) => values.iter().any(contains_credential_field_recursive),
        _ => false,
    }
}

/// Checks only top-level request keys and proxy-config sub-objects (`options`, `provider`,
/// `auth`, `headers`, `config`, `client`, `credentials`, `connection`). Never rejects LLM
/// content or tool-schema fields inside `messages`, `tools`, `arguments`, `input`, etc.
fn contains_credential_field(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.iter().any(|(key, val)| {
        is_credential_name(key)
            || (is_proxy_config_container_key(key) && contains_credential_field_recursive(val))
    })
}

fn validate_request_headers(headers: &HashMap<String, String>) -> Result<(), String> {
    if headers.keys().any(|name| is_credential_name(name)) {
        return Err("credential-bearing request headers are not accepted".to_string());
    }
    Ok(())
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct ParseFailure {
    status: u16,
    code: &'static str,
    detail: &'static str,
}

#[derive(Debug)]
struct ResponseSpec {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
}

impl ResponseSpec {
    fn json(status: u16, value: Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8".to_string(),
            body: serde_json::to_vec(&value)
                .unwrap_or_else(|_| b"{\"error\":\"serialization_error\"}".to_vec()),
            headers: Vec::new(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8".to_string(),
            body: Vec::new(),
            headers: Vec::new(),
        }
    }

    fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.to_string(),
            body,
            headers: Vec::new(),
        }
    }
}

fn json_error(status: u16, code: &str, detail: &str) -> ResponseSpec {
    ResponseSpec::json(status, json!({"error": code, "detail": detail}))
}

fn parse_failure_response(failure: ParseFailure) -> ResponseSpec {
    json_error(failure.status, failure.code, failure.detail)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn is_header_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn parse_header_block(
    header_bytes: &[u8],
) -> Result<(String, String, String, HashMap<String, String>), ParseFailure> {
    let text = std::str::from_utf8(header_bytes).map_err(|_| ParseFailure {
        status: 400,
        code: "malformed_headers",
        detail: "request headers must be valid UTF-8 bytes",
    })?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(ParseFailure {
        status: 400,
        code: "malformed_request_line",
        detail: "request line is missing",
    })?;
    let mut parts = request_line
        .split([' ', '\t'])
        .filter(|part| !part.is_empty());
    let method = parts.next().ok_or(ParseFailure {
        status: 400,
        code: "malformed_request_line",
        detail: "request method is missing",
    })?;
    let target = parts.next().ok_or(ParseFailure {
        status: 400,
        code: "malformed_request_line",
        detail: "request target is missing",
    })?;
    let version = parts.next().ok_or(ParseFailure {
        status: 400,
        code: "malformed_request_line",
        detail: "HTTP version is missing",
    })?;
    if parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(ParseFailure {
            status: 400,
            code: "malformed_request_line",
            detail: "request line is malformed",
        });
    }
    if !method.bytes().all(|byte| {
        byte.is_ascii_uppercase() || byte.is_ascii_digit() || b"!#$%&'*+-.^_`|~".contains(&byte)
    }) {
        return Err(ParseFailure {
            status: 400,
            code: "malformed_request_line",
            detail: "request method is malformed",
        });
    }
    if !target.starts_with('/')
        || target
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b'#')
    {
        return Err(ParseFailure {
            status: 400,
            code: "malformed_request_target",
            detail: "request target is malformed",
        });
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = path.to_string();
    let query = query.to_string();
    if path.is_empty() {
        return Err(ParseFailure {
            status: 400,
            code: "malformed_request_target",
            detail: "request path is empty",
        });
    }

    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or(ParseFailure {
            status: 400,
            code: "malformed_headers",
            detail: "header line is missing a colon",
        })?;
        if name.is_empty() || !name.bytes().all(is_header_name_byte) {
            return Err(ParseFailure {
                status: 400,
                code: "malformed_headers",
                detail: "header name is malformed",
            });
        }
        let value = value.trim();
        if value
            .bytes()
            .any(|byte| byte.is_ascii_control() && byte != b'\t')
        {
            return Err(ParseFailure {
                status: 400,
                code: "malformed_headers",
                detail: "header value is malformed",
            });
        }
        let name = name.to_ascii_lowercase();
        match name.as_str() {
            "cookie" => {
                if let Some(existing) = headers.get_mut("cookie") {
                    existing.push_str("; ");
                    existing.push_str(value);
                } else {
                    headers.insert(name, value.to_string());
                }
            }
            "accept" | "accept-encoding" | "accept-language" | "cache-control" | "pragma"
            | "x-forwarded-for" | "via" | "warning" => {
                if let Some(existing) = headers.get_mut(&name) {
                    existing.push_str(", ");
                    existing.push_str(value);
                } else {
                    headers.insert(name, value.to_string());
                }
            }
            _ => {
                if headers.insert(name, value.to_string()).is_some() {
                    return Err(ParseFailure {
                        status: 400,
                        code: "duplicate_header",
                        detail: "duplicate headers are not accepted",
                    });
                }
            }
        }
    }
    if !headers.contains_key("host") {
        return Err(ParseFailure {
            status: 400,
            code: "missing_host",
            detail: "Host header is required",
        });
    }
    Ok((method.to_string(), path, query, headers))
}

async fn read_request<R>(stream: &mut R, max_body_bytes: usize) -> Result<Request, ParseFailure>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = Vec::with_capacity(8192);
    let header_end = loop {
        if let Some(end) = find_header_end(&buffer) {
            break end + 4;
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err(ParseFailure {
                status: 431,
                code: "headers_too_large",
                detail: "request headers exceed the 64 KiB limit",
            });
        }
        let chunk_size = (MAX_HEADER_BYTES - buffer.len()).clamp(1, 8192);
        let mut chunk = vec![0_u8; chunk_size];
        let read = stream.read(&mut chunk).await.map_err(|_| ParseFailure {
            status: 400,
            code: "request_read_failed",
            detail: "request could not be read",
        })?;
        if read == 0 {
            return Err(ParseFailure {
                status: 400,
                code: "incomplete_request",
                detail: "request ended before headers were complete",
            });
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    if header_end > MAX_HEADER_BYTES {
        return Err(ParseFailure {
            status: 431,
            code: "headers_too_large",
            detail: "request headers exceed the 64 KiB limit",
        });
    }
    let (method, path, query, headers) = parse_header_block(&buffer[..header_end - 4])?;
    if let Some(transfer_encoding) = headers.get("transfer-encoding") {
        if !transfer_encoding.eq_ignore_ascii_case("identity") {
            return Err(ParseFailure {
                status: 400,
                code: "unsupported_transfer_encoding",
                detail: "only identity transfer encoding is supported",
            });
        }
    }
    let content_length = match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| ParseFailure {
            status: 400,
            code: "malformed_content_length",
            detail: "Content-Length is malformed",
        })?,
        None => 0,
    };
    if content_length > max_body_bytes {
        return Err(ParseFailure {
            status: 413,
            code: "body_too_large",
            detail: "request body exceeds the configured limit",
        });
    }
    let initial_body = buffer[header_end..].to_vec();
    if initial_body.len() > content_length {
        return Err(ParseFailure {
            status: 400,
            code: "trailing_request_data",
            detail: "request contains data beyond Content-Length",
        });
    }
    let mut body = initial_body;
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0_u8; remaining.min(8192)];
        let read = stream.read(&mut chunk).await.map_err(|_| ParseFailure {
            status: 400,
            code: "request_read_failed",
            detail: "request body could not be read",
        })?;
        if read == 0 {
            return Err(ParseFailure {
                status: 400,
                code: "incomplete_body",
                detail: "request ended before Content-Length bytes were read",
            });
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

async fn write_response(stream: &mut TcpStream, response: ResponseSpec) -> io::Result<()> {
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n",
        response.status, status_reason(response.status), response.content_type, response.body.len()
    );
    for (name, value) in response.headers {
        header.push_str(&name);
        header.push_str(": ");
        header.push_str(&value);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&response.body).await?;
    stream.flush().await
}

fn add_cors_headers(response: &mut ResponseSpec, origin: Option<&str>) {
    if let Some(origin) = origin {
        response.headers.push((
            "Access-Control-Allow-Origin".to_string(),
            origin.to_string(),
        ));
        response
            .headers
            .push(("Vary".to_string(), "Origin".to_string()));
    }
}

fn provider_headers(
    config: &Config,
    accept: &str,
    dialect: Option<ProviderWireDialect>,
) -> Result<HeaderMap, ResponseSpec> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let accept = HeaderValue::from_str(accept)
        .map_err(|_| json_error(500, "internal_error", "provider Accept header is invalid"))?;
    headers.insert(ACCEPT, accept);
    if dialect == Some(ProviderWireDialect::AnthropicMessages) {
        headers.insert(
            reqwest::header::HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static("2023-06-01"),
        );
    }
    if let Some(api_key) = config.provider_api_key.as_deref() {
        let authorization = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
            json_error(
                503,
                "provider_unavailable",
                "configured provider credential is invalid",
            )
        })?;
        headers.insert(AUTHORIZATION, authorization);
        if dialect == Some(ProviderWireDialect::AnthropicMessages) {
            let x_api_key = HeaderValue::from_str(api_key).map_err(|_| {
                json_error(
                    503,
                    "provider_unavailable",
                    "configured provider credential is invalid",
                )
            })?;
            headers.insert(
                reqwest::header::HeaderName::from_static("x-api-key"),
                x_api_key,
            );
        }
    }
    Ok(headers)
}

fn provider_unavailable(config: &Config) -> ResponseSpec {
    json_error(503, "provider_unavailable", config.provider_error_detail())
}

fn upstream_error(status: u16, detail: &str) -> ResponseSpec {
    json_error(status, "provider_error", detail)
}

fn provider_request_error(error: reqwest::Error) -> ResponseSpec {
    if error.is_timeout() {
        json_error(504, "provider_timeout", "provider request timed out")
    } else {
        upstream_error(502, "provider request failed")
    }
}

fn parse_json_object(request: &Request) -> Result<Value, ResponseSpec> {
    let value: Value = serde_json::from_slice(&request.body)
        .map_err(|_| json_error(400, "invalid_json", "request body must be valid JSON"))?;
    if !value.is_object() {
        return Err(json_error(
            400,
            "invalid_json",
            "request body must be a JSON object",
        ));
    }
    if contains_credential_field(&value) {
        return Err(json_error(
            400,
            "credential_field_rejected",
            "credential-like request fields are not accepted",
        ));
    }
    Ok(value)
}

async fn collect_upstream_body(
    response: reqwest::Response,
    max_body_bytes: usize,
    timeout: Duration,
) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = time::timeout(timeout, stream.next())
        .await
        .map_err(|_| "provider response timed out")?
    {
        let chunk = next.map_err(|_| "provider response could not be read")?;
        if body.len().saturating_add(chunk.len()) > max_body_bytes {
            return Err("provider response exceeds the configured body limit");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn upstream_content_type(response: &reqwest::Response, fallback: &'static str) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

async fn request_models(app: &App) -> Result<Dispatch, ResponseSpec> {
    if app.config.provider_base_url.is_none() {
        return Err(provider_unavailable(&app.config));
    }
    let base = app
        .config
        .provider_base_url
        .as_ref()
        .expect("base URL was checked");
    let url = endpoint(base, &app.config.provider_models_path).map_err(|_| {
        json_error(
            503,
            "provider_unavailable",
            "provider models endpoint is invalid",
        )
    })?;
    let headers = provider_headers(&app.config, "application/json", None)?;
    let response = time::timeout(
        app.config.provider_timeout,
        app.client.get(url).headers(headers).send(),
    )
    .await
    .map_err(|_| json_error(504, "provider_timeout", "provider request timed out"))?
    .map_err(provider_request_error)?;
    if !response.status().is_success() {
        return Err(upstream_error(
            502,
            "provider returned an unsuccessful models response",
        ));
    }
    let status = response.status().as_u16();
    let content_type = upstream_content_type(&response, "application/json; charset=utf-8");
    let body = collect_upstream_body(
        response,
        app.config.max_body_bytes,
        app.config.provider_timeout,
    )
    .await
    .map_err(|detail| upstream_error(502, detail))?;

    if !app.config.provider_model_allowlist.is_empty() {
        if let Ok(mut json_val) = serde_json::from_slice::<Value>(&body) {
            let mut modified = false;
            if let Some(data) = json_val.get_mut("data").and_then(Value::as_array_mut) {
                data.retain(|item| {
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        app.config
                            .provider_model_allowlist
                            .iter()
                            .any(|allowed| allowed == id)
                    } else {
                        false
                    }
                });
                modified = true;
            } else if let Some(models) = json_val.get_mut("models").and_then(Value::as_array_mut) {
                models.retain(|item| {
                    if let Some(id) = item
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                    {
                        app.config
                            .provider_model_allowlist
                            .iter()
                            .any(|allowed| allowed == id)
                    } else {
                        false
                    }
                });
                modified = true;
            }
            if modified {
                if let Ok(new_body) = serde_json::to_vec(&json_val) {
                    return Ok(Dispatch::Response(ResponseSpec::bytes(
                        status,
                        &content_type,
                        new_body,
                    )));
                }
            }
        }
    }

    Ok(Dispatch::Response(ResponseSpec::bytes(
        status,
        &content_type,
        body,
    )))
}

fn parse_wire_dialect(raw: &str) -> Option<ProviderWireDialect> {
    match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "openai_responses" | "responses" => Some(ProviderWireDialect::OpenAiResponses),
        "anthropic_messages" | "anthropic" | "messages" => {
            Some(ProviderWireDialect::AnthropicMessages)
        }
        "gemini_chat_completions" | "gemini" => Some(ProviderWireDialect::GeminiChatCompletions),
        "local_aux_gguf" | "local_gguf" | "local" => Some(ProviderWireDialect::LocalAuxGguf),
        _ => None,
    }
}

fn parse_retry_after_ms(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| secs.saturating_mul(1_000).min(60_000))
}

fn is_retryable_upstream_status(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504)
}

fn retry_backoff_delay(attempt: u32, retry_after_ms: Option<u64>) -> Duration {
    if let Some(ra) = retry_after_ms {
        return Duration::from_millis(ra.min(2_000));
    }
    let exp = 50u64.saturating_mul(1u64 << attempt.min(5));
    let jitter = (u64::try_from(now_epoch_ms()).unwrap_or(0) % 25) + 5;
    Duration::from_millis((exp + jitter).min(2_000))
}

async fn request_chat(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    request_chat_with_dialect(app, request, None).await
}

async fn request_chat_with_dialect(
    app: &App,
    request: &Request,
    route_dialect: Option<ProviderWireDialect>,
) -> Result<Dispatch, ResponseSpec> {
    if !app.config.provider_configured() {
        return Err(provider_unavailable(&app.config));
    }
    let mut body = parse_json_object(request)?;
    let explicit_dialect = body
        .as_object_mut()
        .and_then(|obj| obj.remove("wire_dialect"))
        .and_then(|val| val.as_str().and_then(parse_wire_dialect));
    let active_dialect = route_dialect.or(explicit_dialect);

    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let requested_model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            app.config
                .provider_model
                .as_ref()
                .expect("provider model was checked")
                .clone()
        });
    if !app.config.provider_model_allowlist.is_empty()
        && !app
            .config
            .provider_model_allowlist
            .iter()
            .any(|allowed| allowed == &requested_model)
    {
        return Err(json_error(
            403,
            "model_not_allowed",
            "requested model is not in the configured allowlist",
        ));
    }
    body.as_object_mut()
        .expect("request body is an object")
        .insert("model".to_string(), Value::String(requested_model.clone()));

    if let Some(dialect) = active_dialect {
        let normalized = normalize_provider_wire_payload(dialect, &body).map_err(|err| {
            json_error(400, "invalid_wire_payload", &err.to_string())
        })?;
        body = normalized.into_value();
    }

    let serialized = serde_json::to_vec(&body)
        .map_err(|_| json_error(400, "invalid_json", "request body could not be serialized"))?;
    let endpoint_path = match active_dialect {
        Some(ProviderWireDialect::OpenAiResponses) => "responses",
        Some(ProviderWireDialect::AnthropicMessages) => "messages",
        _ => app.config.provider_chat_path.as_str(),
    };
    let accept_header = if stream {
        "text/event-stream"
    } else {
        "application/json"
    };

    let max_attempts = app.config.provider_max_retries.saturating_add(1);
    let mut excluded_candidates: Vec<String> = Vec::new();
    let mut last_error: Option<ResponseSpec> = None;

    for attempt in 0..max_attempts {
        let Some((candidate_id, base)) =
            app.select_candidate_for_attempt(&requested_model, attempt, &excluded_candidates)
        else {
            return Err(provider_unavailable(&app.config));
        };
        let url = endpoint(&base, endpoint_path).map_err(|_| {
            json_error(
                503,
                "provider_unavailable",
                "provider chat endpoint is invalid",
            )
        })?;
        let mut headers = provider_headers(&app.config, accept_header, active_dialect)?;
        let http_client = if attempt >= 1 {
            // Use non-pooled retry client + `Connection: close` so retries force a brand-new TCP/TLS socket.
            headers.insert(CONNECTION, HeaderValue::from_static("close"));
            &app.retry_client
        } else {
            &app.client
        };

        let send_result = time::timeout(
            app.config.provider_header_timeout,
            http_client
                .request(Method::POST, url)
                .headers(headers)
                .body(serialized.clone())
                .send(),
        )
        .await;

        let response = match send_result {
            Ok(Ok(resp)) => resp,
            Ok(Err(err)) => {
                let status = if err.is_timeout() { 504 } else { 502 };
                app.record_candidate_outcome(
                    &candidate_id,
                    &requested_model,
                    status,
                    None,
                    FailureScope::AccountCooldown,
                );
                if app.candidate_urls.len() > 1 {
                    excluded_candidates.push(candidate_id);
                }
                last_error = Some(provider_request_error(err));
                if attempt + 1 < max_attempts {
                    time::sleep(retry_backoff_delay(attempt, None)).await;
                    continue;
                }
                return Err(last_error.expect("error recorded"));
            }
            Err(_) => {
                app.record_candidate_outcome(
                    &candidate_id,
                    &requested_model,
                    504,
                    None,
                    FailureScope::AccountCooldown,
                );
                if app.candidate_urls.len() > 1 {
                    excluded_candidates.push(candidate_id);
                }
                last_error = Some(json_error(
                    504,
                    "provider_timeout",
                    "provider request timed out",
                ));
                if attempt + 1 < max_attempts {
                    time::sleep(retry_backoff_delay(attempt, None)).await;
                    continue;
                }
                return Err(last_error.expect("timeout recorded"));
            }
        };

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let retry_after_ms = parse_retry_after_ms(&response);
            let scope = if status == 429 {
                FailureScope::AccountQuota
            } else if matches!(status, 400 | 409 | 413 | 422) {
                FailureScope::None
            } else {
                FailureScope::AccountCooldown
            };
            app.record_candidate_outcome(
                &candidate_id,
                &requested_model,
                status,
                retry_after_ms,
                scope,
            );
            if is_retryable_upstream_status(status) && attempt + 1 < max_attempts {
                if app.candidate_urls.len() > 1 {
                    excluded_candidates.push(candidate_id);
                }
                time::sleep(retry_backoff_delay(attempt, retry_after_ms)).await;
                continue;
            }
            return Err(upstream_error(
                502,
                "provider returned an unsuccessful chat response",
            ));
        }

        app.record_candidate_outcome(&candidate_id, &requested_model, status, None, FailureScope::None);
        if stream {
            return Ok(Dispatch::Stream(response));
        }
        let content_type = upstream_content_type(&response, "application/json; charset=utf-8");
        let body = collect_upstream_body(
            response,
            app.config.max_body_bytes,
            app.config.provider_token_timeout,
        )
        .await
        .map_err(|detail| upstream_error(502, detail))?;
        return Ok(Dispatch::Response(ResponseSpec::bytes(
            status,
            &content_type,
            body,
        )));
    }

    Err(last_error
        .unwrap_or_else(|| upstream_error(502, "provider returned an unsuccessful chat response")))
}

#[derive(Debug)]
enum Dispatch {
    Response(ResponseSpec),
    Stream(reqwest::Response),
}

fn health_response(app: &App) -> ResponseSpec {
    ResponseSpec::json(
        200,
        json!({
            "ok": true,
            "service": "omnia-runtime",
            "transport": "tokio-http",
            "bind": app.config.bind,
            "providerConfigured": app.config.provider_configured(),
            "providerBaseUrlConfigured": app.config.provider_base_url.is_some(),
            "providerModelConfigured": app.config.provider_model.is_some(),
            "skills": app.config.skills.state_value(),
            "hardwareNvidia": "on-demand-probe",
        }),
    )
}

fn seed_configured_models_router(router: &DynamicProviderRouter, config: &Config) {
    if config.provider_base_url.is_some() {
        let model = config
            .provider_model
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let cand = RouteCandidate {
            candidate_id: format!("env-primary:{model}"),
            provider_id: "htmustc".to_string(),
            model_id: model,
            auth_boundary: "default".to_string(),
            region: "configured".to_string(),
            privacy_tier: PrivacyTier::Public,
            capabilities: ModelCapabilities::standard_candidate(),
            context_limit_tokens: 128_000,
            max_output_tokens: 16_384,
            quality_tier: 3,
            pricing_version: "env".to_string(),
            input_cost_per_million_microunits: None,
            output_cost_per_million_microunits: None,
            credential_present: config.provider_configured(),
            enabled: true,
            route_priority: 5,
            supported_roles: Vec::new(),
        };
        let state = CandidateResourceState {
            quota: QuotaState::default(),
            circuit: CircuitState::Closed,
            ..CandidateResourceState::default()
        };
        let _ = router.upsert_candidate(cand, state);
    }

    let providers = read_models_config(None)
        .ok()
        .map(|cfg| cfg.providers)
        .unwrap_or_default();
    for (priority, prov) in providers.iter().enumerate() {
        let provider_id = &prov.id;
        let cred_ok = CredentialStore::resolve_secret(&format!("omnia:provider:{provider_id}"))
            .ok()
            .flatten()
            .is_some();
        let has_cred = cred_ok || runtime_key_spec_configured(&prov.api_key);
        for (idx, m) in prov.models.iter().enumerate() {
            let mut caps = ModelCapabilities::standard_candidate();
            caps.supports_reasoning = m.thinking.is_some();
            let cand = RouteCandidate {
                candidate_id: format!("{provider_id}:{}", m.id),
                provider_id: provider_id.clone(),
                model_id: m.id.clone(),
                auth_boundary: "default".to_string(),
                region: "configured".to_string(),
                privacy_tier: PrivacyTier::Public,
                capabilities: caps,
                context_limit_tokens: m.context_window,
                max_output_tokens: m.max_tokens,
                quality_tier: 3,
                pricing_version: "models.yml".to_string(),
                input_cost_per_million_microunits: None,
                output_cost_per_million_microunits: None,
                credential_present: has_cred,
                enabled: true,
                route_priority: ((priority * 20) + idx + 20) as i32,
                supported_roles: Vec::new(),
            };
            let state = CandidateResourceState {
                quota: QuotaState::default(),
                circuit: CircuitState::Closed,
                ..CandidateResourceState::default()
            };
            let _ = router.upsert_candidate(cand, state);
        }
    }
}

fn runtime_key_spec_configured(key_spec: &str) -> bool {
    let trimmed = key_spec.trim();
    !trimmed.is_empty()
        && (env::var(trimmed).ok().is_some_and(|v| !v.trim().is_empty())
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()))
}

fn has_provider_credential(
    provider_id: &str,
    env_var: &str,
    providers: &[omnia_agent::ProviderConfig],
) -> bool {
    env::var(env_var)
        .ok()
        .is_some_and(|v| !v.trim().is_empty())
        || CredentialStore::resolve_secret(&format!("omnia:provider:{provider_id}"))
            .ok()
            .flatten()
            .is_some()
        || providers
            .iter()
            .any(|p| p.id == provider_id && runtime_key_spec_configured(&p.api_key))
}

fn providers_response(app: &App) -> ResponseSpec {
    let providers_cfg = read_models_config(None)
        .ok()
        .map(|cfg| cfg.providers)
        .unwrap_or_default();
    let htmustc_configured = app.config.provider_configured();
    let htmustc_available = htmustc_configured && app.config.provider_config_error.is_none();
    let nvidia_configured = has_provider_credential("nvidia_nim", "NVIDIA_API_KEY", &providers_cfg);
    let ollama_configured = has_provider_credential("ollama_local", "OLLAMA_HOST", &providers_cfg)
        || providers_cfg.iter().any(|p| p.id == "ollama");
    let providers = json!([
        {
            "id": "htmustc",
            "classification": "remote_proxy",
            "configured": htmustc_configured,
            "available": htmustc_available
        },
        {
            "id": "nvidia_nim",
            "classification": "remote_cloud",
            "configured": nvidia_configured,
            "available": nvidia_configured
        },
        {
            "id": "ollama_local",
            "classification": "local_daemon",
            "configured": ollama_configured,
            "available": ollama_configured
        }
    ]);
    ResponseSpec::json(
        200,
        json!({
            "service": "omnia-runtime",
            "providers": providers
        }),
    )
}

fn capabilities_response(app: &App) -> ResponseSpec {
    ResponseSpec::json(
        200,
        json!({
            "service": "omnia-runtime",
            "state": "ready",
            "capabilities": {
                "health": true,
                "models": app.config.provider_base_url.is_some(),
                "chat": app.config.provider_configured(),
                "stream": app.config.provider_configured(),
                "skills": app.config.skills.is_ready(),
                "hardwareNvidia": "on-demand-probe",
                "cancel": "connection-close",
                "loopbackOnly": true,
            },
        }),
    )
}

fn skill_query_response(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    match app.config.skills.discovery(&request.query) {
        Ok(value) => {
            let status = if app.config.skills.is_ready() {
                200
            } else {
                503
            };
            Ok(Dispatch::Response(ResponseSpec::json(status, value)))
        }
        Err(error) => Err(skill_error_response(error)),
    }
}

fn skill_content_response(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    match app.config.skills.content(&request.query) {
        Ok(value) => Ok(Dispatch::Response(ResponseSpec::json(200, value))),
        Err(error) => Err(skill_error_response(error)),
    }
}

fn skill_error_response(error: QueryError) -> ResponseSpec {
    match error {
        QueryError::Invalid(detail) => json_error(400, "skills_query_invalid", &detail),
        QueryError::Unavailable { code, detail } | QueryError::Error { code, detail } => {
            json_error(503, &code, &detail)
        }
        QueryError::NotFound => json_error(404, "skill_not_found", "skill was not found"),
    }
}

async fn dispatch_request(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") | ("GET", "/health") | ("GET", "/api/health") => {
            Ok(Dispatch::Response(health_response(app)))
        }
        ("GET", "/capabilities") | ("GET", "/api/capabilities") => {
            Ok(Dispatch::Response(capabilities_response(app)))
        }
        ("GET", "/api/providers") | ("GET", "/providers") => {
            Ok(Dispatch::Response(providers_response(app)))
        }
        ("GET", "/api/skills") | ("GET", "/skills") => skill_query_response(app, request),
        ("GET", "/api/skills/content") | ("GET", "/skills/content") => {
            skill_content_response(app, request)
        }
        ("GET", "/api/hardware/nvidia") | ("GET", "/hardware/nvidia") => {
            if !request.query.is_empty() {
                return Err(json_error(
                    400,
                    "nvidia_query_invalid",
                    "NVIDIA hardware probe does not accept query parameters",
                ));
            }
            let (status, body) = nvidia::probe(&app.config.nvidia).await;
            Ok(Dispatch::Response(ResponseSpec::json(status, body)))
        }
        ("GET", "/models") | ("GET", "/v1/models") | ("GET", "/api/models") => {
            request_models(app).await
        }
        ("GET", "/api/agent/backends") => {
            let backends = app.harness.list_backends(None);
            Ok(Dispatch::Response(ResponseSpec::json(
                200,
                json!({ "ok": true, "backends": backends }),
            )))
        }
        ("GET", "/api/agent/sessions") => {
            let sessions = app.harness.list_running();
            Ok(Dispatch::Response(ResponseSpec::json(
                200,
                json!({ "ok": true, "sessions": sessions }),
            )))
        }
        ("POST", "/api/agent/spawn") => handle_runtime_agent_spawn(app, request).await,
        ("POST", "/api/agent/prompt") => handle_runtime_agent_prompt(app, request).await,
        ("POST", "/api/agent/abort") => handle_runtime_agent_abort(app, request).await,
        ("GET", "/api/router/state") => handle_runtime_router_state(app),
        ("POST", "/api/router/decide") => handle_runtime_router_decide(app, request),
        ("POST", "/chat/completions")
        | ("POST", "/v1/chat/completions")
        | ("POST", "/api/chat/completions")
        | ("POST", "/api/chat")
        | ("POST", "/chat") => request_chat(app, request).await,
        ("POST", "/v1/responses") | ("POST", "/api/responses") => {
            request_chat_with_dialect(app, request, Some(ProviderWireDialect::OpenAiResponses))
                .await
        }
        ("POST", "/v1/messages") | ("POST", "/api/messages") => {
            request_chat_with_dialect(app, request, Some(ProviderWireDialect::AnthropicMessages))
                .await
        }
        ("OPTIONS", _) => {
            let mut response = ResponseSpec::empty(204);
            response.headers.push((
                "Access-Control-Allow-Methods".to_string(),
                "GET, POST, OPTIONS".to_string(),
            ));
            response.headers.push((
                "Access-Control-Allow-Headers".to_string(),
                "Content-Type".to_string(),
            ));
            Ok(Dispatch::Response(response))
        }
        ("GET", _) | ("POST", _) => Err(json_error(404, "not_found", "route was not found")),
        _ => {
            let mut response = json_error(405, "method_not_allowed", "method is not allowed");
            response
                .headers
                .push(("Allow".to_string(), "GET, POST, OPTIONS".to_string()));
            Err(response)
        }
    }
}

async fn handle_runtime_agent_spawn(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    let body = parse_json_object(request)?;
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
    let tab_id = body
        .get("sessionId")
        .or_else(|| body.get("tabId"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("rt-sess-{}", RUNTIME_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)));
    let provider = body.get("provider").and_then(Value::as_str).map(ToString::to_string);
    let model_id = body
        .get("model")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| app.config.provider_model.clone());
    let spec_str = match (provider.as_deref(), model_id.as_deref()) {
        (Some(p), Some(m)) => format!("{p}/{m}"),
        (_, Some(m)) => m.to_string(),
        _ => "default".to_string(),
    };
    let resolved = resolve_model_endpoint(&spec_str, None, None, None).ok();
    let req = ManagedSpawnRequest {
        tab_id: tab_id.clone(),
        cwd,
        backend: HarnessBackendId::OmniSuper,
        approval_mode: ApprovalMode::AlwaysAsk,
        workspace_trusted: true,
        permission_rules: Vec::new(),
        provider: resolved.as_ref().map(|r| r.provider_id.clone()).or(provider),
        model_id: resolved.as_ref().map(|r| r.model_id.clone()).or(model_id),
        thinking_level: body.get("thinking").and_then(Value::as_str).map(ToString::to_string),
        wire_api: WireApiMode::Auto,
        config_dir: None,
        max_turns: 16,
    };
    let sink: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(|_| {});
    match app.harness.spawn_session(req, sink).await {
        Ok((session_key, pid, state)) => Ok(Dispatch::Response(ResponseSpec::json(
            200,
            json!({
                "ok": true,
                "sessionKey": session_key,
                "sessionId": tab_id,
                "pid": pid,
                "state": state,
            }),
        ))),
        Err(e) => Err(json_error(503, "agent_spawn_failed", &e.to_string())),
    }
}

async fn handle_runtime_agent_prompt(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    let body = parse_json_object(request)?;
    let key = body
        .get("sessionKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| json_error(400, "missing_session_key", "sessionKey is required"))?;
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| json_error(400, "missing_prompt", "prompt is required"))?;
    match app.harness.send_prompt(key, prompt).await {
        Ok(ack) => Ok(Dispatch::Response(ResponseSpec::json(
            200,
            json!({ "ok": true, "ack": ack }),
        ))),
        Err(e) => Err(json_error(400, "prompt_failed", &e.to_string())),
    }
}

async fn handle_runtime_agent_abort(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    let body = parse_json_object(request)?;
    let key = body
        .get("sessionKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| json_error(400, "missing_session_key", "sessionKey is required"))?;
    app.harness.abort_session(key);
    Ok(Dispatch::Response(ResponseSpec::json(
        200,
        json!({ "ok": true, "sessionKey": key, "aborted": true }),
    )))
}

fn handle_runtime_router_state(app: &App) -> Result<Dispatch, ResponseSpec> {
    let snaps = app
        .dynamic_router
        .snapshots(now_epoch_ms())
        .unwrap_or_default();
    let ids: Vec<String> = snaps.into_iter().map(|s| s.candidate.candidate_id).collect();
    Ok(Dispatch::Response(ResponseSpec::json(
        200,
        json!({
            "ok": true,
            "service": "omnia-runtime",
            "tokenBudget": Value::Null,
            "candidateCount": ids.len(),
            "candidateIds": ids,
        }),
    )))
}

fn handle_runtime_router_decide(app: &App, request: &Request) -> Result<Dispatch, ResponseSpec> {
    let body = parse_json_object(request)?;
    let mut policy = RouteRequestPolicy {
        token_budget: None,
        now_epoch_ms: Some(now_epoch_ms()),
        ..RouteRequestPolicy::default()
    };
    if let Some(req_id) = body.get("requestId").and_then(Value::as_str) {
        if !req_id.trim().is_empty() {
            policy.request_id = req_id.trim().to_string();
        }
    }
    if body.get("taskRisk").and_then(Value::as_str) == Some("high") {
        policy.task_risk = TaskRisk::High;
    }
    match app.dynamic_router.decide_and_reserve(&policy) {
        Ok(decision) => Ok(Dispatch::Response(ResponseSpec::json(
            200,
            json!({
                "ok": true,
                "allowed": decision.allowed,
                "tokenBudget": Value::Null,
                "selectedCandidateId": decision.receipt.selected_candidate_id,
            }),
        ))),
        Err(e) => Err(json_error(503, "route_decision_failed", &e.to_string())),
    }
}

async fn wait_for_client_disconnect(reader: &mut OwnedReadHalf) -> io::Result<()> {
    let mut buffer = [0_u8; 1024];
    loop {
        reader.readable().await?;
        match reader.try_read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Persistent cross-chunk SSE line parser ensuring split keepalive comments (e.g., `":"`
/// followed by `" ping\n\n"`) never falsely reset the token-progress stall watchdog.
#[derive(Debug, Clone, Copy)]
struct SseProgressTracker {
    at_line_start: bool,
    in_comment_line: bool,
}

impl SseProgressTracker {
    const fn new() -> Self {
        Self {
            at_line_start: true,
            in_comment_line: false,
        }
    }

    fn feed(&mut self, chunk: &[u8]) -> bool {
        let mut meaningful = false;
        for &byte in chunk {
            if byte == b'\n' {
                self.at_line_start = true;
                self.in_comment_line = false;
                continue;
            }
            if byte == b'\r' {
                continue;
            }
            if self.at_line_start {
                if byte == b' ' || byte == b'\t' {
                    continue;
                }
                self.at_line_start = false;
                if byte == b':' {
                    self.in_comment_line = true;
                } else {
                    self.in_comment_line = false;
                    meaningful = true;
                }
            } else if !self.in_comment_line {
                meaningful = true;
            }
        }
        meaningful
    }
}

fn validate_fetch_site(fetch_site: Option<&str>) -> Result<(), String> {
    let Some(raw) = fetch_site else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed
        .split(',')
        .map(str::trim)
        .any(|token| token.eq_ignore_ascii_case("cross-site"))
    {
        return Err("Cross-site requests are rejected by Sec-Fetch-Site guard".to_string());
    }
    Ok(())
}

async fn write_stream_response(
    stream: &mut OwnedWriteHalf,
    reader: &mut OwnedReadHalf,
    response: reqwest::Response,
    origin: Option<&str>,
    max_body_bytes: usize,
    token_timeout: Duration,
) -> io::Result<()> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/event-stream");
    let mut header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n",
        status,
        status_reason(status),
        content_type
    );
    if let Some(origin) = origin {
        header.push_str("Access-Control-Allow-Origin: ");
        header.push_str(origin);
        header.push_str("\r\nVary: Origin\r\n");
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;

    let mut body_bytes = 0usize;
    let mut upstream = response.bytes_stream();
    let mut progress_tracker = SseProgressTracker::new();
    let mut token_deadline = time::Instant::now() + token_timeout;
    let client_disconnect = wait_for_client_disconnect(reader);
    tokio::pin!(client_disconnect);
    loop {
        let remaining = token_deadline.saturating_duration_since(time::Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "provider stream token-progress timed out",
            ));
        }
        let next = tokio::select! {
            result = &mut client_disconnect => {
                return result.and_then(|_| {
                    Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "stream client disconnected",
                    ))
                });
            }
            result = time::timeout(remaining, upstream.next()) => result,
        };
        let chunk = match next {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(None) => break,
            Ok(Some(Err(_))) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "provider stream ended unexpectedly",
                ));
            }
            Err(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "provider stream token-progress timed out",
                ));
            }
        };
        if body_bytes.saturating_add(chunk.len()) > max_body_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "provider stream exceeded the configured limit",
            ));
        }
        if chunk.is_empty() {
            continue;
        }
        if progress_tracker.feed(&chunk) {
            token_deadline = time::Instant::now() + token_timeout;
        }
        body_bytes += chunk.len();
        let size = format!("{:X}\r\n", chunk.len());
        stream.write_all(size.as_bytes()).await?;
        stream.write_all(&chunk).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
    }
    stream.write_all(b"0\r\n\r\n").await?;
    stream.flush().await
}

async fn serve_connection(mut stream: TcpStream, app: App) -> io::Result<()> {
    let request = match time::timeout(
        app.config.provider_timeout,
        read_request(&mut stream, app.config.max_body_bytes),
    )
    .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(failure)) => {
            return write_response(&mut stream, parse_failure_response(failure)).await;
        }
        Err(_) => {
            return write_response(
                &mut stream,
                json_error(408, "request_timeout", "request read timed out"),
            )
            .await;
        }
    };
    let origin = request.headers.get("origin").map(String::as_str);
    if let Err(detail) = request
        .headers
        .get("host")
        .ok_or_else(|| "Host header is required".to_string())
        .and_then(|host| validate_host_header(host))
    {
        return write_response(&mut stream, json_error(403, "invalid_host", &detail)).await;
    }
    if let Err(detail) = validate_origin(origin, &app.config.allowed_origins) {
        return write_response(&mut stream, json_error(403, "invalid_origin", &detail)).await;
    }
    let fetch_site = request.headers.get("sec-fetch-site").map(String::as_str);
    if let Err(detail) = validate_fetch_site(fetch_site) {
        return write_response(&mut stream, json_error(403, "forbidden_cross_site", &detail)).await;
    }
    if let Err(detail) = validate_request_headers(&request.headers) {
        let mut response = json_error(400, "credential_header_rejected", &detail);
        add_cors_headers(&mut response, origin);
        return write_response(&mut stream, response).await;
    }

    match dispatch_request(&app, &request).await {
        Ok(Dispatch::Response(mut response)) => {
            add_cors_headers(&mut response, origin);
            write_response(&mut stream, response).await
        }
        Ok(Dispatch::Stream(response)) => {
            let (mut reader, mut writer) = stream.into_split();
            write_stream_response(
                &mut writer,
                &mut reader,
                response,
                origin,
                app.config.max_body_bytes,
                app.config.provider_token_timeout,
            )
            .await
        }
        Err(mut response) => {
            add_cors_headers(&mut response, origin);
            write_response(&mut stream, response).await
        }
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env();
    let bind = parse_loopback_bind(&config.bind)?;
    let app = App::new(config.clone())?;
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|error| format!("unable to bind runtime listener: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("unable to read runtime listener: {error}"))?;
    eprintln!(
        "omnia-runtime listening on {} (provider_configured={})",
        address,
        config.provider_configured()
    );
    loop {
        let (stream, peer) = listener
            .accept()
            .await
            .map_err(|error| format!("listener accept failed: {error}"))?;
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, app).await {
                eprintln!("omnia-runtime connection {} failed: {}", peer, error);
            }
        });
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("omnia-runtime: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            bind: "127.0.0.1:0".to_string(),
            allowed_origins: vec!["http://localhost:8787".to_string()],
            max_body_bytes: 1024,
            provider_base_url: None,
            provider_fallback_urls: Vec::new(),
            provider_model: None,
            provider_api_key: None,
            provider_timeout: Duration::from_millis(250),
            provider_connect_timeout: Duration::from_millis(250),
            provider_header_timeout: Duration::from_millis(250),
            provider_token_timeout: Duration::from_millis(250),
            provider_max_retries: 0,
            provider_chat_path: DEFAULT_CHAT_PATH.to_string(),
            provider_models_path: DEFAULT_MODELS_PATH.to_string(),
            provider_config_error: Some("provider is not configured for this test".to_string()),
            skills: SkillCatalog::load(None, None),
            nvidia: NvidiaConfig::from_env(),
            provider_model_allowlist: Vec::new(),
        }
    }

    fn test_app() -> App {
        App::new(test_config()).expect("test client should initialize")
    }

    fn provider_config(base_url: Url) -> Config {
        Config {
            bind: "127.0.0.1:0".to_string(),
            allowed_origins: vec!["http://localhost:8787".to_string()],
            max_body_bytes: 4096,
            provider_base_url: Some(base_url),
            provider_fallback_urls: Vec::new(),
            provider_model: Some("transport-test-model".to_string()),
            provider_api_key: None,
            provider_timeout: Duration::from_secs(2),
            provider_connect_timeout: Duration::from_secs(2),
            provider_header_timeout: Duration::from_secs(2),
            provider_token_timeout: Duration::from_secs(2),
            provider_max_retries: 1,
            provider_chat_path: DEFAULT_CHAT_PATH.to_string(),
            provider_models_path: DEFAULT_MODELS_PATH.to_string(),
            provider_config_error: None,
            skills: SkillCatalog::load(None, None),
            nvidia: NvidiaConfig::from_env(),
            provider_model_allowlist: Vec::new(),
        }
    }

    async fn spawn_provider_response(response: Vec<u8>) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("provider listener should bind");
        let address = listener
            .local_addr()
            .expect("provider address should exist");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("provider should accept");
            read_request(&mut stream, 4096)
                .await
                .expect("provider request should be complete");
            stream
                .write_all(&response)
                .await
                .expect("provider response should write");
            stream
                .flush()
                .await
                .expect("provider response should flush");
        });
        (
            Url::parse(&format!("http://{address}")).expect("provider URL should parse"),
            task,
        )
    }

    async fn spawn_provider_headers_then_wait(
        headers: Vec<u8>,
    ) -> (Url, tokio::task::JoinHandle<Result<(), io::Error>>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("provider listener should bind");
        let address = listener
            .local_addr()
            .expect("provider address should exist");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            read_request(&mut stream, 4096)
                .await
                .map_err(|failure| io::Error::new(io::ErrorKind::InvalidData, failure.detail))?;
            stream.write_all(&headers).await?;
            stream.flush().await?;
            let mut buffer = [0_u8; 1024];
            loop {
                match stream.read(&mut buffer).await {
                    Ok(0) => return Ok(()),
                    Ok(_) => {}
                    Err(error) => return Err(error),
                }
            }
        });
        (
            Url::parse(&format!("http://{address}")).expect("provider URL should parse"),
            task,
        )
    }

    fn request(method: &str, path: &str, body: &[u8]) -> Request {
        let mut headers = HashMap::new();
        headers.insert("host".to_string(), "127.0.0.1".to_string());
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        Request {
            method: method.to_string(),
            path: path.to_string(),
            query: query.to_string(),
            headers,
            body: body.to_vec(),
        }
    }

    fn json_body(response: &ResponseSpec) -> Value {
        serde_json::from_slice(&response.body).expect("response body should be JSON")
    }

    #[test]
    fn loopback_bind_rejects_non_loopback_addresses() {
        assert_eq!(
            parse_loopback_bind("127.0.0.1:8790")
                .expect("IPv4 loopback should be accepted")
                .port(),
            8790
        );
        assert!(parse_loopback_bind("[::1]:8790").is_ok());
        assert!(parse_loopback_bind("0.0.0.0:8790").is_err());
        assert!(parse_loopback_bind("localhost:8790").is_err());
        assert!(parse_loopback_bind("127.0.0.1:0").is_ok());
    }

    #[test]
    fn provider_url_and_endpoint_keep_paths_bounded() {
        let base = parse_provider_url("https://gateway.example.test/v1/").unwrap();
        assert_eq!(
            endpoint(&base, "/chat/completions").unwrap().as_str(),
            "https://gateway.example.test/v1/chat/completions"
        );
        assert!(parse_provider_url("ftp://gateway.example.test").is_err());
        assert!(parse_provider_url("https://user@gateway.example.test").is_err());
        assert!(parse_provider_url("https://gateway.example.test?token=redacted").is_err());
        assert!(endpoint(&base, "models?limit=1").is_err());
        assert!(endpoint(&base, "").is_err());
    }

    #[test]
    fn host_and_origin_validation_are_loopback_scoped() {
        assert!(validate_host_header("localhost").is_ok());
        assert!(validate_host_header("127.0.0.1:8790").is_ok());
        assert!(validate_host_header("[::1]:8790").is_ok());
        assert!(validate_host_header("127.0.0.2").is_err());
        assert!(validate_host_header("localhost:0").is_err());
        assert!(validate_host_header("localhost,127.0.0.1").is_err());

        let allowed = vec!["http://localhost:8787".to_string()];
        assert!(validate_origin(None, &allowed).is_ok());
        assert!(validate_origin(Some("http://localhost:8787"), &allowed).is_ok());
        assert!(validate_origin(Some("http://evil.test"), &allowed).is_err());
        assert!(validate_origin(Some(""), &allowed).is_err());
    }

    #[test]
    fn credential_detection_covers_headers_and_nested_json() {
        assert!(is_credential_name("Authorization"));
        assert!(is_credential_name("x-api-key"));
        assert!(is_credential_name("session_token"));
        assert!(!is_credential_name("Content-Type"));

        let nested = json!({
            "messages": [{"content": "hello"}],
            "options": {"api_key": "must not cross this boundary"}
        });
        assert!(contains_credential_field(&nested));

        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        assert!(validate_request_headers(&headers).is_ok());
        headers.insert("authorization".to_string(), "Bearer omitted".to_string());
        assert!(validate_request_headers(&headers).is_err());
    }

    #[test]
    fn parser_rejects_duplicate_missing_and_invalid_headers() {
        let valid = b"GET /health?detail=1 HTTP/1.1\r\nHost: localhost\r\n";
        let (method, path, query, headers) =
            parse_header_block(valid).expect("valid request should parse");
        assert_eq!(method, "GET");
        assert_eq!(path, "/health");
        assert_eq!(query, "detail=1");
        assert_eq!(headers.get("host").map(String::as_str), Some("localhost"));

        let duplicate = b"GET / HTTP/1.1\r\nHost: localhost\r\nhost: localhost\r\n";
        assert_eq!(
            parse_header_block(duplicate)
                .expect_err("duplicate headers should fail")
                .code,
            "duplicate_header"
        );

        let missing_host = b"GET / HTTP/1.1\r\nAccept: application/json\r\n";
        assert_eq!(
            parse_header_block(missing_host)
                .expect_err("Host is mandatory")
                .code,
            "missing_host"
        );

        let malformed_name = b"GET / HTTP/1.1\r\nHo st: localhost\r\n";
        assert_eq!(
            parse_header_block(malformed_name)
                .expect_err("invalid header names should fail")
                .code,
            "malformed_headers"
        );
    }

    #[test]
    fn json_parser_requires_object_and_rejects_credential_fields() {
        let valid = request("POST", "/chat/completions", br#"{"messages":[]}"#);
        assert!(parse_json_object(&valid).is_ok());

        let array = request("POST", "/chat/completions", br#"[]"#);
        let array_error = parse_json_object(&array).expect_err("arrays are not request objects");
        assert_eq!(array_error.status, 400);
        assert_eq!(json_body(&array_error)["error"], "invalid_json");

        let credential = request(
            "POST",
            "/chat/completions",
            br#"{"options":{"api_key":"provided-by-client"}}"#,
        );
        let credential_error =
            parse_json_object(&credential).expect_err("credential fields must be rejected");
        assert_eq!(credential_error.status, 400);
        assert_eq!(
            json_body(&credential_error)["error"],
            "credential_field_rejected"
        );
    }

    #[tokio::test]
    async fn request_reader_enforces_content_length_and_body_limit() {
        let (mut server_stream, mut client_stream) = tokio::io::duplex(4096);
        let sender = tokio::spawn(async move {
            client_stream
                .write_all(
                    b"POST /chat/completions HTTP/1.1\r\n\
                      Host: localhost\r\n\
                      Content-Length: 8\r\n\
                      \r\n\
                      {\"ok\":1}",
                )
                .await
                .unwrap();
        });
        let parsed = read_request(&mut server_stream, 1024)
            .await
            .expect("complete body should parse");
        assert_eq!(parsed.body, br#"{"ok":1}"#);
        sender.await.unwrap();

        let (mut server_stream, mut client_stream) = tokio::io::duplex(4096);
        let sender = tokio::spawn(async move {
            client_stream
                .write_all(
                    b"POST /chat/completions HTTP/1.1\r\n\
                      Host: localhost\r\n\
                      Content-Length: 8\r\n\
                      \r\n\
                      12345678",
                )
                .await
                .unwrap();
        });
        let failure = read_request(&mut server_stream, 4)
            .await
            .expect_err("body limit should be enforced");
        assert_eq!(failure.status, 413);
        assert_eq!(failure.code, "body_too_large");
        sender.await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_reports_capabilities_and_unavailable_provider() {
        let app = test_app();

        let health = dispatch_request(&app, &request("GET", "/api/health", &[]))
            .await
            .expect("health route should dispatch");
        let Dispatch::Response(health) = health else {
            panic!("health route must return a regular response");
        };
        assert_eq!(health.status, 200);
        assert_eq!(json_body(&health)["service"], "omnia-runtime");
        assert_eq!(json_body(&health)["providerConfigured"], false);

        let capabilities = dispatch_request(&app, &request("GET", "/capabilities", &[]))
            .await
            .expect("capabilities route should dispatch");
        let Dispatch::Response(capabilities) = capabilities else {
            panic!("capabilities route must return a regular response");
        };
        assert_eq!(capabilities.status, 200);
        assert_eq!(
            json_body(&capabilities)["capabilities"]["loopbackOnly"],
            true
        );

        let models = match dispatch_request(&app, &request("GET", "/models", &[])).await {
            Ok(_) => panic!("unconfigured provider must be explicit"),
            Err(response) => response,
        };
        assert_eq!(models.status, 503);
        assert_eq!(json_body(&models)["error"], "provider_unavailable");

        let chat = match dispatch_request(
            &app,
            &request("POST", "/chat/completions", br#"{"messages":[]}"#),
        )
        .await
        {
            Ok(_) => panic!("unconfigured provider must be explicit"),
            Err(response) => response,
        };
        assert_eq!(chat.status, 503);
        assert_eq!(json_body(&chat)["error"], "provider_unavailable");
    }

    #[tokio::test]
    async fn skills_routes_report_unavailable_state_without_fabricating_content() {
        let app = test_app();
        let discovery = dispatch_request(&app, &request("GET", "/api/skills", &[]))
            .await
            .expect("skills discovery should return a response");
        let Dispatch::Response(discovery) = discovery else {
            panic!("skills discovery must return a regular response");
        };
        assert_eq!(discovery.status, 503);
        assert_eq!(json_body(&discovery)["state"], "unavailable");
        assert_eq!(
            json_body(&discovery)["skills"].as_array().map(Vec::len),
            Some(0)
        );

        let content = match dispatch_request(
            &app,
            &request("GET", "/api/skills/content?name=kdense-test", &[]),
        )
        .await
        {
            Ok(_) => panic!("unavailable skill content must fail explicitly"),
            Err(response) => response,
        };
        assert_eq!(content.status, 503);
        assert_eq!(json_body(&content)["error"], "skills_unavailable");
    }

    #[tokio::test]
    async fn nvidia_routes_reject_query_parameters_without_starting_probe() {
        let app = test_app();
        for path in [
            "/api/hardware/nvidia?device=0",
            "/hardware/nvidia?executable=other",
        ] {
            let response = match dispatch_request(&app, &request("GET", path, &[])).await {
                Ok(_) => panic!("query parameters must be rejected"),
                Err(response) => response,
            };
            assert_eq!(response.status, 400);
            assert_eq!(json_body(&response)["error"], "nvidia_query_invalid");
        }
    }

    #[tokio::test]
    async fn dispatch_preserves_route_and_method_errors() {
        let app = test_app();

        let missing = match dispatch_request(&app, &request("GET", "/missing", &[])).await {
            Ok(_) => panic!("unknown route should fail"),
            Err(response) => response,
        };
        assert_eq!(missing.status, 404);
        assert_eq!(json_body(&missing)["error"], "not_found");

        let method = match dispatch_request(&app, &request("DELETE", "/health", &[])).await {
            Ok(_) => panic!("unsupported method should fail"),
            Err(response) => response,
        };
        assert_eq!(method.status, 405);
        assert_eq!(
            method
                .headers
                .iter()
                .find(|(name, _)| name == "Allow")
                .map(|(_, value)| value.as_str()),
            Some("GET, POST, OPTIONS")
        );

        let options = dispatch_request(&app, &request("OPTIONS", "/any", &[]))
            .await
            .expect("OPTIONS should dispatch for a preflight path");
        let Dispatch::Response(options) = options else {
            panic!("OPTIONS must return a regular response");
        };
        assert_eq!(options.status, 204);
        assert!(
            options
                .headers
                .iter()
                .any(|(name, value)| name == "Access-Control-Allow-Headers"
                    && value == "Content-Type")
        );
    }

    #[tokio::test]
    async fn request_chat_preserves_provider_status_content_type_and_body() {
        let body = br#"{"transport":"received","bytes":7}"#;
        let response = format!(
            "HTTP/1.1 201 Created\r\nContent-Type: application/custom+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        )
        .into_bytes();
        let (base_url, provider_task) = spawn_provider_response(response).await;
        let app = App::new(provider_config(base_url)).expect("test app should initialize");
        let result = request_chat(
            &app,
            &request("POST", "/chat/completions", br#"{"messages":[]}"#),
        )
        .await
        .expect("provider response should dispatch");
        let Dispatch::Response(response) = result else {
            panic!("non-stream chat should return a regular response");
        };
        assert_eq!(response.status, 201);
        assert_eq!(response.content_type, "application/custom+json");
        assert_eq!(response.body, body);
        provider_task.await.expect("provider task should finish");
    }

    #[tokio::test]
    async fn write_stream_response_forwards_sse_chunks_and_cors() {
        let event_body = b"data: {\"delta\":\"received\"}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            event_body.len(),
            String::from_utf8_lossy(event_body)
        )
        .into_bytes();
        let (base_url, provider_task) = spawn_provider_response(response).await;
        let app = App::new(provider_config(base_url)).expect("test app should initialize");
        let result = request_chat(
            &app,
            &request(
                "POST",
                "/chat/completions",
                br#"{"messages":[],"stream":true}"#,
            ),
        )
        .await
        .expect("stream provider response should dispatch");
        let Dispatch::Stream(response) = result else {
            panic!("stream request must return a provider stream");
        };
        let output_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("output listener should bind");
        let output_address = output_listener
            .local_addr()
            .expect("output address should exist");
        let client_task = tokio::spawn(async move {
            TcpStream::connect(output_address)
                .await
                .expect("output client should connect")
        });
        let (server_stream, _) = output_listener
            .accept()
            .await
            .expect("output server should accept");
        let mut client_stream = client_task.await.expect("output client task should finish");
        let (mut reader, mut writer) = server_stream.into_split();
        write_stream_response(
            &mut writer,
            &mut reader,
            response,
            Some("http://localhost:8787"),
            4096,
            Duration::from_secs(2),
        )
        .await
        .expect("stream response should write");
        drop(writer);
        drop(reader);
        let mut output = Vec::new();
        time::timeout(
            Duration::from_secs(2),
            client_stream.read_to_end(&mut output),
        )
        .await
        .expect("output response should finish")
        .expect("output client should read response");
        let output = String::from_utf8(output).expect("output should be UTF-8");
        assert!(output.contains("HTTP/1.1 200 OK\r\n"));
        assert!(output.contains("Content-Type: text/event-stream\r\n"));
        assert!(output.contains("Transfer-Encoding: chunked\r\n"));
        assert!(output.contains("Access-Control-Allow-Origin: http://localhost:8787\r\n"));
        assert!(output.contains("data: {\"delta\":\"received\"}\n\n"));
        assert!(output.ends_with("0\r\n\r\n"));
        provider_task.await.expect("provider task should finish");
    }

    #[tokio::test]
    async fn write_stream_response_stops_when_client_disconnects() {
        let headers =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n"
                .to_vec();
        let (base_url, provider_task) = spawn_provider_headers_then_wait(headers).await;
        let app = App::new(provider_config(base_url)).expect("test app should initialize");
        let result = request_chat(
            &app,
            &request(
                "POST",
                "/chat/completions",
                br#"{"messages":[],"stream":true}"#,
            ),
        )
        .await
        .expect("stream provider response should dispatch");
        let Dispatch::Stream(response) = result else {
            panic!("stream request must return a provider stream");
        };
        let output_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("output listener should bind");
        let output_address = output_listener
            .local_addr()
            .expect("output address should exist");
        let client_task = tokio::spawn(async move {
            TcpStream::connect(output_address)
                .await
                .expect("output client should connect")
        });
        let (server_stream, _) = output_listener
            .accept()
            .await
            .expect("output server should accept");
        let mut client_stream = client_task.await.expect("output client task should finish");
        let (mut reader, mut writer) = server_stream.into_split();
        let write_task = tokio::spawn(async move {
            write_stream_response(
                &mut writer,
                &mut reader,
                response,
                None,
                4096,
                Duration::from_secs(2),
            )
            .await
        });
        let mut header = Vec::new();
        let mut buffer = [0_u8; 512];
        while !header.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = time::timeout(Duration::from_secs(2), client_stream.read(&mut buffer))
                .await
                .expect("stream header should arrive")
                .expect("client should read stream header");
            assert!(read > 0, "stream ended before headers were written");
            header.extend_from_slice(&buffer[..read]);
        }
        client_stream
            .shutdown()
            .await
            .expect("client should close its connection");
        let result = time::timeout(Duration::from_secs(2), write_task)
            .await
            .expect("stream writer should stop after disconnect")
            .expect("stream writer task should join")
            .expect_err("disconnect should return an I/O error");
        assert_eq!(result.kind(), io::ErrorKind::BrokenPipe);
        time::timeout(Duration::from_secs(2), provider_task)
            .await
            .expect("upstream connection should close after cancellation")
            .expect("provider task should join")
            .expect("provider connection should finish cleanly");
    }

    #[test]
    fn parse_header_block_coalesces_15_cookies_and_standard_headers() {
        let mut raw = String::from("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n");
        for i in 1..=15 {
            raw.push_str(&format!(
                "Cookie: fixture_session_{}=dummy_val_{}\r\n",
                i, i
            ));
        }
        raw.push_str("Accept: text/html\r\n");
        raw.push_str("Accept: application/json\r\n");
        raw.push_str("Accept-Encoding: gzip\r\n");
        raw.push_str("Accept-Encoding: br\r\n\r\n");

        let (method, path, query, headers) =
            parse_header_block(raw.as_bytes()).expect("header block should parse");
        assert_eq!(method, "GET");
        assert_eq!(path, "/api/health");
        assert_eq!(query, "");

        let cookie_header = headers
            .get("cookie")
            .expect("cookie header must be present");
        assert!(
            cookie_header.contains("fixture_session_1=dummy_val_1; fixture_session_2=dummy_val_2")
        );
        assert!(cookie_header.contains("fixture_session_15=dummy_val_15"));
        assert_eq!(cookie_header.matches("; ").count(), 14);

        let accept_header = headers
            .get("accept")
            .expect("accept header must be present");
        assert_eq!(accept_header, "text/html, application/json");

        let accept_enc = headers
            .get("accept-encoding")
            .expect("accept-encoding present");
        assert_eq!(accept_enc, "gzip, br");
    }

    #[test]
    fn parse_header_block_rejects_security_sensitive_duplicates() {
        let raw = b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer fixture-dummy-1\r\nAuthorization: Bearer fixture-dummy-2\r\n\r\n";
        let err = parse_header_block(raw).expect_err("duplicate authorization must be rejected");
        assert_eq!(err.code, "duplicate_header");

        let raw_cl =
            b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n";
        let err_cl =
            parse_header_block(raw_cl).expect_err("duplicate content-length must be rejected");
        assert_eq!(err_cl.code, "duplicate_header");
    }

    #[test]
    fn parse_header_block_tolerates_extra_whitespace_in_request_line() {
        let raw = b"GET   /api/health \t  HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n\r\n";
        let (method, path, query, _) =
            parse_header_block(raw).expect("multi-space request line must parse");
        assert_eq!(method, "GET");
        assert_eq!(path, "/api/health");
        assert_eq!(query, "");
    }

    #[tokio::test]
    async fn post_api_chat_routes_correctly() {
        let response_body = br#"{"id":"chat-1","choices":[{"message":{"content":"lane3a-test"}}]}"#;
        let upstream_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            response_body.len(),
            std::str::from_utf8(response_body).unwrap()
        )
        .into_bytes();
        let (base_url, provider_task) = spawn_provider_response(upstream_response).await;
        let app = App::new(provider_config(base_url)).expect("test app should initialize");

        let req = request(
            "POST",
            "/api/chat",
            br#"{"messages":[{"role":"user","content":"hi"}]}"#,
        );
        let dispatch = dispatch_request(&app, &req)
            .await
            .expect("/api/chat should dispatch");
        match dispatch {
            Dispatch::Response(spec) => {
                assert_eq!(spec.status, 200);
                let val: Value = serde_json::from_slice(&spec.body).unwrap();
                assert_eq!(val["id"], "chat-1");
            }
            _ => panic!("expected response spec"),
        }
        provider_task.await.expect("provider task should finish");
    }

    #[tokio::test]
    async fn get_api_providers_returns_zero_secrets() {
        let app = test_app();
        let req = request("GET", "/api/providers", b"");
        let dispatch = dispatch_request(&app, &req)
            .await
            .expect("/api/providers should dispatch");
        match dispatch {
            Dispatch::Response(spec) => {
                assert_eq!(spec.status, 200);
                let val: Value = serde_json::from_slice(&spec.body).unwrap();
                assert_eq!(val["service"], "omnia-runtime");
                let providers = val["providers"].as_array().expect("providers list");
                assert_eq!(providers.len(), 3);
                for p in providers {
                    assert!(p.get("id").is_some());
                    assert!(p.get("classification").is_some());
                    assert!(p.get("configured").is_some());
                    assert!(p.get("available").is_some());
                    assert!(p.get("key").is_none());
                    assert!(p.get("api_key").is_none());
                    assert!(p.get("token").is_none());
                    assert!(p.get("secret").is_none());
                }
            }
            _ => panic!("expected response spec"),
        }
    }

    #[tokio::test]
    async fn model_allowlist_enforces_allowed_models() {
        let mut cfg = test_config();
        cfg.provider_base_url = Some(Url::parse("http://127.0.0.1:9999").unwrap());
        cfg.provider_model = Some("allowed-model-1".to_string());
        cfg.provider_model_allowlist =
            vec!["allowed-model-1".to_string(), "allowed-model-2".to_string()];
        let app = App::new(cfg).expect("test app should initialize");

        // Disallowed model
        let req_bad = request(
            "POST",
            "/api/chat",
            br#"{"model":"forbidden-model","messages":[]}"#,
        );
        let err = request_chat(&app, &req_bad)
            .await
            .expect_err("disallowed model must fail");
        assert_eq!(err.status, 403);
        let err_val: Value = serde_json::from_slice(&err.body).unwrap();
        assert_eq!(err_val["error"], "model_not_allowed");

        // Allowed model without running upstream (check that it fails on network connect, not 403)
        let req_ok = request(
            "POST",
            "/api/chat",
            br#"{"model":"allowed-model-2","messages":[]}"#,
        );
        let err_ok = request_chat(&app, &req_ok)
            .await
            .expect_err("allowed model proceeds to upstream");
        assert_ne!(err_ok.status, 403);
    }

    #[tokio::test]
    async fn serve_connection_accepts_15_adguard_cookies_and_multi_space_request_line_while_rejecting_auth(
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = test_app();

        // 1. Multi-space request line + 15 Cookie headers (AdGuard loopback pattern)
        let server_app = app.clone();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_connection(stream, server_app).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        let mut raw_req = String::from(
            "GET  /api/health   HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nConnection: close\r\n",
        );
        for idx in 0..15 {
            raw_req.push_str(&format!(
                "Cookie: ___Shortbread_fixture_{idx}=dummy_val_{idx}\r\n"
            ));
        }
        raw_req.push_str("\r\n");
        client.write_all(raw_req.as_bytes()).await.unwrap();
        let mut raw_resp = Vec::new();
        client.read_to_end(&mut raw_resp).await.unwrap();
        server_task.await.unwrap();
        let resp_text = String::from_utf8(raw_resp).unwrap();
        assert!(
            resp_text.starts_with("HTTP/1.1 200 OK\r\n"),
            "unexpected status line: {resp_text}"
        );
        let (_, body) = resp_text.split_once("\r\n\r\n").unwrap();
        let parsed: Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed["ok"], true);

        // 2. Authorization header must still fail with 400 credential_header_rejected
        let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr2 = listener2.local_addr().unwrap();
        let server_task2 = tokio::spawn(async move {
            let (stream, _) = listener2.accept().await.unwrap();
            serve_connection(stream, app).await.unwrap();
        });
        let mut client2 = TcpStream::connect(addr2).await.unwrap();
        let auth_req = concat!(
            "GET  /api/health HTTP/1.1\r\n",
            "Host: 127.0.0.1:8790\r\n",
            "Authorization: Bearer dummy-fixture\r\n",
            "Connection: close\r\n\r\n"
        );
        client2.write_all(auth_req.as_bytes()).await.unwrap();
        let mut raw_resp2 = Vec::new();
        client2.read_to_end(&mut raw_resp2).await.unwrap();
        server_task2.await.unwrap();
        let resp_text2 = String::from_utf8(raw_resp2).unwrap();
        assert!(
            resp_text2.starts_with("HTTP/1.1 400 Bad Request\r\n"),
            "unexpected status line: {resp_text2}"
        );
        assert!(resp_text2.contains("credential_header_rejected"));
    }

    #[tokio::test]
    async fn model_allowlist_filters_api_models() {
        let upstream_body = br#"{"object":"list","data":[{"id":"allowed-model-1"},{"id":"forbidden-model"},{"id":"allowed-model-2"}]}"#;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            upstream_body.len()
        );
        let mut response_bytes = header.into_bytes();
        response_bytes.extend_from_slice(upstream_body);
        let (base_url, handle) = spawn_provider_response(response_bytes).await;

        let mut cfg = provider_config(base_url);
        cfg.provider_model_allowlist =
            vec!["allowed-model-1".to_string(), "allowed-model-2".to_string()];
        let app = App::new(cfg).expect("provider allowlist app initializes");
        let resp = match request_models(&app).await.expect("models should succeed") {
            Dispatch::Response(spec) => spec,
            Dispatch::Stream(_) => panic!("expected buffered models response"),
        };
        assert_eq!(resp.status, 200);
        let parsed = json_body(&resp);
        let ids: Vec<&str> = parsed["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["allowed-model-1", "allowed-model-2"]);
        handle.await.unwrap();
    }

    #[test]
    fn contains_credential_field_allows_messages_and_tools_while_rejecting_top_level_and_options() {
        let valid_tool_payload = json!({
            "model": "gpt-5.4",
            "messages": [
                {
                    "role": "user",
                    "content": "Explain how OAuth token rotation works",
                    "metadata": { "token": "not-a-proxy-credential", "secret": "example" }
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "verify_auth",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "token": { "type": "string" },
                                "api_key": { "type": "string" },
                                "password": { "type": "string" },
                                "max_tokens": { "type": "integer" }
                            }
                        }
                    }
                }
            ]
        });
        assert!(
            !contains_credential_field(&valid_tool_payload),
            "LLM messages and tool schemas must never trigger false-400 credential rejection"
        );
        let parsed_req = request(
            "POST",
            "/v1/chat/completions",
            serde_json::to_vec(&valid_tool_payload).unwrap().as_slice(),
        );
        assert!(parse_json_object(&parsed_req).is_ok());

        for bad in [
            json!({ "api_key": "client-supplied", "messages": [] }),
            json!({ "authorization": "Bearer x", "messages": [] }),
            json!({ "options": { "secret": "nested-config-secret" }, "messages": [] }),
            json!({ "headers": { "x-api-key": "header-secret" }, "messages": [] }),
        ] {
            assert!(
                contains_credential_field(&bad),
                "top-level or proxy-config credential field must still be rejected: {bad}"
            );
        }
    }

    #[tokio::test]
    async fn split_budget_stream_survives_steady_tokens_and_times_out_on_keepalive_only_stall() {
        // Case 1: Steady meaningful SSE chunks spanning 480ms with token_timeout=220ms MUST succeed
        // (proving there is no hard total `.timeout(...)` killing healthy long streams!).
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let steady_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut stream, 4096).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            for chunk in [
                "data: {\"delta\":\"a\"}\n\n",
                "data: {\"delta\":\"b\"}\n\n",
                "data: {\"delta\":\"c\"}\n\n",
                "data: [DONE]\n\n",
            ] {
                let frame = format!("{:X}\r\n{chunk}\r\n", chunk.len());
                stream.write_all(frame.as_bytes()).await.unwrap();
                stream.flush().await.unwrap();
                time::sleep(Duration::from_millis(120)).await;
            }
            stream.write_all(b"0\r\n\r\n").await.unwrap();
            stream.flush().await.unwrap();
        });

        let mut cfg = provider_config(Url::parse(&format!("http://{addr}")).unwrap());
        cfg.provider_token_timeout = Duration::from_millis(260);
        cfg.provider_timeout = Duration::from_millis(260);
        let app = App::new(cfg).unwrap();

        let Dispatch::Stream(resp) = request_chat(
            &app,
            &request("POST", "/api/chat", br#"{"messages":[],"stream":true}"#),
        )
        .await
        .expect("steady stream connects") else {
            panic!("expected stream");
        };
        let out_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let out_addr = out_listener.local_addr().unwrap();
        let client_fut = tokio::spawn(async move { TcpStream::connect(out_addr).await.unwrap() });
        let (srv_stream, _) = out_listener.accept().await.unwrap();
        let mut client = client_fut.await.unwrap();
        let (mut reader, mut writer) = srv_stream.into_split();
        write_stream_response(
            &mut writer,
            &mut reader,
            resp,
            None,
            8192,
            Duration::from_millis(260),
        )
        .await
        .expect("steady stream spanning >260ms must complete cleanly");
        drop(writer);
        drop(reader);
        let mut collected = Vec::new();
        client.read_to_end(&mut collected).await.unwrap();
        let text = String::from_utf8(collected).unwrap();
        assert!(text.contains("data: [DONE]"));
        steady_task.await.unwrap();

        // Case 2: Keepalive-only `: ping\n\n` chunks MUST NOT reset the token-progress timeout!
        let ka_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ka_addr = ka_listener.local_addr().unwrap();
        let _ka_task = tokio::spawn(async move {
            let (mut stream, _) = ka_listener.accept().await.unwrap();
            let _ = read_request(&mut stream, 4096).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            for _ in 0..12 {
                let ping = ": ping\n\n";
                let frame = format!("{:X}\r\n{ping}\r\n", ping.len());
                if stream.write_all(frame.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stream.flush().await;
                time::sleep(Duration::from_millis(45)).await;
            }
        });

        let mut cfg2 = provider_config(Url::parse(&format!("http://{ka_addr}")).unwrap());
        cfg2.provider_token_timeout = Duration::from_millis(160);
        let app2 = App::new(cfg2).unwrap();
        let Dispatch::Stream(resp2) = request_chat(
            &app2,
            &request("POST", "/api/chat", br#"{"messages":[],"stream":true}"#),
        )
        .await
        .expect("keepalive stream connects") else {
            panic!("expected stream");
        };
        let out_listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let out_addr2 = out_listener2.local_addr().unwrap();
        let client_fut2 = tokio::spawn(async move { TcpStream::connect(out_addr2).await.unwrap() });
        let (srv_stream2, _) = out_listener2.accept().await.unwrap();
        let _client2 = client_fut2.await.unwrap();
        let (mut reader2, mut writer2) = srv_stream2.into_split();
        let err = write_stream_response(
            &mut writer2,
            &mut reader2,
            resp2,
            None,
            8192,
            Duration::from_millis(160),
        )
        .await
        .expect_err("keepalive-only stream must trigger token-progress timeout");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn request_chat_retries_with_connection_close_and_updates_proxy_router() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            // Attempt 1: return retryable 502 Bad Gateway
            let (mut s1, _) = listener.accept().await.unwrap();
            let req1 = read_request(&mut s1, 4096).await.unwrap();
            assert_ne!(
                req1.headers.get("connection").map(String::as_str),
                Some("close")
            );
            s1.write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"error\":\"gw\"}",
            )
            .await
            .unwrap();
            s1.flush().await.unwrap();

            // Attempt 2: verify `Connection: close` retry header and return 200 OK
            let (mut s2, _) = listener.accept().await.unwrap();
            let req2 = read_request(&mut s2, 4096).await.unwrap();
            assert_eq!(
                req2.headers.get("connection").map(String::as_str),
                Some("close"),
                "retry attempt must rotate socket with Connection: close"
            );
            let ok_body = br#"{"id":"recovered-after-retry"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                ok_body.len(),
                std::str::from_utf8(ok_body).unwrap()
            );
            s2.write_all(resp.as_bytes()).await.unwrap();
            s2.flush().await.unwrap();
        });

        let mut cfg = provider_config(Url::parse(&format!("http://{addr}")).unwrap());
        cfg.provider_max_retries = 2;
        let app = App::new(cfg).unwrap();
        let Dispatch::Response(spec) = request_chat(
            &app,
            &request("POST", "/api/chat", br#"{"messages":[{"role":"user","content":"hi"}]}"#),
        )
        .await
        .expect("retry should recover from initial 502") else {
            panic!("expected buffered response");
        };
        assert_eq!(spec.status, 200);
        assert_eq!(json_body(&spec)["id"], "recovered-after-retry");

        {
            let router = app.proxy_router.lock().unwrap();
            assert_eq!(router.candidates().len(), 1);
            assert_eq!(router.candidates()[0].consecutive_failures, 0);
            assert_eq!(router.candidates()[0].last_status, Some(200));
        }
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn dispatch_normalizes_wire_adapter_payload_for_v1_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let req = read_request(&mut stream, 8192).await.unwrap();
            assert_eq!(req.path, "/responses");
            let sent: Value = serde_json::from_slice(&req.body).unwrap();
            // Foreign Anthropic/Gemini keys must be stripped by omnia_routing::wire_adapter!
            assert!(sent.get("anthropic_version").is_none());
            assert!(sent.get("thinking_config").is_none());
            assert_eq!(sent["model"], "transport-test-model");
            let ok_body = br#"{"id":"resp-normalized"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                ok_body.len(),
                std::str::from_utf8(ok_body).unwrap()
            );
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
        });

        let app = App::new(provider_config(Url::parse(&format!("http://{addr}")).unwrap())).unwrap();
        let req = request(
            "POST",
            "/v1/responses",
            br#"{"input":"hello","anthropic_version":"2023-06-01","thinking_config":{"thinkingBudget":1024}}"#,
        );
        let Dispatch::Response(spec) = dispatch_request(&app, &req)
            .await
            .expect("/v1/responses should normalize and forward") else {
            panic!("expected buffered response");
        };
        assert_eq!(spec.status, 200);
        assert_eq!(json_body(&spec)["id"], "resp-normalized");
        server_task.await.unwrap();
    }

    #[test]
    fn split_chunk_sse_keepalive_never_resets_token_progress_watchdog() {
        let mut tracker = SseProgressTracker::new();
        // Split `: ping\n\n` across two separate TCP packets must NOT count as progress!
        assert!(!tracker.feed(b":"));
        assert!(!tracker.feed(b" ping\n\n"));
        assert!(!tracker.feed(b"   \r\n: keep"));
        assert!(!tracker.feed(b"alive\n"));
        // Real data payload line MUST count as progress!
        assert!(tracker.feed(b"data: {\"delta\":\"ok\"}\n\n"));
        // Subsequent split comment again must NOT count as progress.
        assert!(!tracker.feed(b":"));
        assert!(!tracker.feed(b" heartbeat\r\n\r\n"));
    }

    #[tokio::test]
    async fn explicit_wire_dialect_routes_anthropic_messages_with_version_and_x_api_key_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let synth_key = ["omnia", "anth", "fixture", "key999"].join("-");
        let expected_key = synth_key.clone();
        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let req = read_request(&mut stream, 8192).await.unwrap();
            assert_eq!(
                req.path, "/messages",
                "explicit wire_dialect must route to /messages endpoint"
            );
            assert_eq!(
                req.headers.get("anthropic-version").map(String::as_str),
                Some("2023-06-01")
            );
            assert_eq!(
                req.headers.get("x-api-key").map(String::as_str),
                Some(expected_key.as_str())
            );
            let ok_body = br#"{"id":"msg-1","type":"message"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                ok_body.len(),
                std::str::from_utf8(ok_body).unwrap()
            );
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
        });

        let mut cfg = provider_config(Url::parse(&format!("http://{addr}")).unwrap());
        cfg.provider_api_key = Some(synth_key);
        let app = App::new(cfg).unwrap();
        let req = request(
            "POST",
            "/api/chat",
            br#"{"wire_dialect":"anthropic_messages","messages":[{"role":"user","content":"hi"}]}"#,
        );
        let Dispatch::Response(spec) = dispatch_request(&app, &req)
            .await
            .expect("explicit anthropic_messages dialect should route cleanly") else {
            panic!("expected buffered response");
        };
        assert_eq!(spec.status, 200);
        assert_eq!(json_body(&spec)["id"], "msg-1");
        server_task.await.unwrap();
    }

    #[tokio::test]
    async fn serve_connection_blocks_cross_site_sec_fetch_site() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = test_app();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_connection(stream, app).await.unwrap();
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"GET /api/hardware/nvidia HTTP/1.1\r\nHost: 127.0.0.1:8790\r\nSec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut raw_resp = Vec::new();
        client.read_to_end(&mut raw_resp).await.unwrap();
        server_task.await.unwrap();
        let resp_text = String::from_utf8(raw_resp).unwrap();
        assert!(resp_text.starts_with("HTTP/1.1 403 Forbidden\r\n"));
        assert!(resp_text.contains("forbidden_cross_site"));
    }

    #[tokio::test]
    async fn runtime_exposes_unified_agent_and_router_sidecar_routes() {
        let app = test_app();
        let backends = dispatch_request(&app, &request("GET", "/api/agent/backends", b""))
            .await
            .expect("/api/agent/backends dispatches");
        let Dispatch::Response(backends_resp) = backends else {
            panic!("expected buffered backends response");
        };
        assert_eq!(backends_resp.status, 200);
        assert_eq!(json_body(&backends_resp)["ok"], true);

        let sessions = dispatch_request(&app, &request("GET", "/api/agent/sessions", b""))
            .await
            .expect("/api/agent/sessions dispatches");
        let Dispatch::Response(sessions_resp) = sessions else {
            panic!("expected buffered sessions response");
        };
        assert_eq!(sessions_resp.status, 200);
        assert_eq!(json_body(&sessions_resp)["ok"], true);

        let router = dispatch_request(&app, &request("GET", "/api/router/state", b""))
            .await
            .expect("/api/router/state dispatches");
        let Dispatch::Response(router_resp) = router else {
            panic!("expected buffered router state response");
        };
        assert_eq!(router_resp.status, 200);
        let rv = json_body(&router_resp);
        assert_eq!(rv["ok"], true);
        assert!(rv["tokenBudget"].is_null());
    }
}
