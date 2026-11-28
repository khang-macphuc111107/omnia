//! Native Rust Network Identity, DNS Intelligence, Proxy/PAC/TLS Chain Inspector,
//! Passive Upstream Waterfall, and On-Demand Cancellable Speedtest / Bufferbloat Engine.
//!
//! All Windows networking DLLs (`iphlpapi.dll`, `winhttp.dll`, `wlanapi.dll`) are loaded
//! dynamically via `LoadLibraryW` + `GetProcAddress` ONLY on invocation so CLI cold-start
//! latency (`omnia.exe --version <= 15 ms`) and binary size (`<= 14 MiB`) remain unaffected.
//! Never probes `agy` or reads `~/.gemini` OAuth tokens; never fabricates offline data.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Provenance tag distinguishing live measurements from cached or unavailable values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DataProvenance {
    Live,
    Cached,
    Unavailable,
}

impl DataProvenance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "LIVE",
            Self::Cached => "CACHED",
            Self::Unavailable => "UNAVAILABLE",
        }
    }
}

/// Options controlling [`inspect_network_identity`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetDiagOptions {
    /// Whether to perform outbound public IP / GeoIP lookups (`false` = local NICs only).
    pub probe_public_ip: bool,
    /// Timeout in milliseconds for outbound HTTP probes (clamped `500..=6000`).
    pub timeout_ms: u64,
    /// Bypass the 15-second in-memory cache for public IP/GeoIP probes.
    pub force_refresh: bool,
}

impl Default for NetDiagOptions {
    fn default() -> Self {
        Self {
            probe_public_ip: true,
            timeout_ms: 2_500,
            force_refresh: false,
        }
    }
}

/// GeoIP / ASN metadata returned from an unauthenticated public trace/meta endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoIpInfo {
    pub asn: Option<String>,
    pub isp: Option<String>,
    pub org: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub colo: Option<String>,
    pub source: String,
}

fn default_stream_mode() -> String {
    "multi".to_string()
}

fn default_risk_low() -> String {
    "low".to_string()
}

/// Local network adapter inventory item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NicAdapterInfo {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub status: String,
    pub ipv4_cidrs: Vec<String>,
    pub ipv6_cidrs: Vec<String>,
    #[serde(default)]
    pub ipv6_global: Vec<String>,
    #[serde(default)]
    pub ipv6_link_local: Vec<String>,
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
    pub dns_suffix: Option<String>,
    pub mtu: u32,
    pub link_speed_mbps: Option<u64>,
    pub mac_address: Option<String>,
    pub vpn_tag: Option<String>,
    #[serde(default)]
    pub rx_bytes: u64,
    #[serde(default)]
    pub tx_bytes: u64,
    #[serde(default)]
    pub rx_bps: u64,
    #[serde(default)]
    pub tx_bps: u64,
    #[serde(default)]
    pub if_index: u32,
}

/// Active Wi-Fi link & RF telemetry when exposed by Windows WLAN API / netsh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiLinkInfo {
    pub interface_name: String,
    pub ssid: String,
    pub signal_pct: u32,
    pub rx_mbps: Option<u64>,
    pub tx_mbps: Option<u64>,
    pub state: String,
    #[serde(default)]
    pub bssid: Option<String>,
    #[serde(default)]
    pub rssi_dbm: Option<i32>,
    #[serde(default)]
    pub radio_phy: Option<String>,
    #[serde(default)]
    pub band: Option<String>,
    #[serde(default)]
    pub channel: Option<u32>,
    #[serde(default)]
    pub auth_cipher: Option<String>,
}

/// Mapped public socket discovered by RFC 5389 STUN Binding probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StunMappedAddress {
    pub ip: String,
    pub port: u16,
    pub attribute: String,
}

/// Pure-Rust RFC 5389 UDP STUN NAT mapping inspection result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StunProbeReport {
    pub status: DataProvenance,
    pub server: Option<String>,
    pub mapped_ip: Option<String>,
    pub mapped_port: Option<u16>,
    pub attribute: Option<String>,
    pub nat_mapping_behavior: String,
    pub endpoints_probed: Vec<String>,
    pub rtt_ms: Option<u64>,
    pub error: Option<String>,
}

/// Complete local & public network identity snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkIdentityReport {
    pub provenance: DataProvenance,
    pub public_ipv4: Option<String>,
    pub public_ipv6: Option<String>,
    pub ipv6_reachable: bool,
    pub geo: Option<GeoIpInfo>,
    pub adapters: Vec<NicAdapterInfo>,
    pub wifi: Option<WifiLinkInfo>,
    pub nat_classification: String,
    pub vpn_active: bool,
    pub vpn_tags: Vec<String>,
    pub fingerprint_sha256: String,
    pub observed_at_ms: i64,
    pub detail: Option<String>,
    #[serde(default)]
    pub stun: Option<StunProbeReport>,
    #[serde(default)]
    pub ptr: Option<String>,
    #[serde(default)]
    pub network_type: String,
    #[serde(default)]
    pub split_tunnel_mode: String,
    #[serde(default)]
    pub split_tunnel_reason: Option<String>,
    #[serde(default)]
    pub local_ip_class: String,
    #[serde(default)]
    pub cgnat_evidence: Option<String>,
    #[serde(default)]
    pub warp_active: bool,
    #[serde(default)]
    pub warp_status: Option<String>,
    #[serde(default)]
    pub total_rx_bps: u64,
    #[serde(default)]
    pub total_tx_bps: u64,
}

/// Options controlling [`inspect_dns_and_benchmark`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsBenchOptions {
    /// Domain queried during multi-resolver benchmark (defaults to `"example.com"`).
    pub query_domain: String,
    /// Number of trials per resolver (clamped `1..=8`, default `4`).
    pub trials: usize,
    /// Per-query UDP timeout in milliseconds (clamped `200..=3000`, default `1000`).
    pub timeout_ms: u64,
    /// Whether to run active UDP resolver benchmarks (`false` = passive config only).
    pub run_benchmark: bool,
    /// Optional known public IPv4 (used for VPN DNS leak comparison without re-probing).
    pub public_ipv4_hint: Option<String>,
    /// Optional custom DNS resolver IPv4/IPv6 tested alongside default public resolvers.
    #[serde(default)]
    pub custom_dns_ip: Option<String>,
}

impl Default for DnsBenchOptions {
    fn default() -> Self {
        Self {
            query_domain: "example.com".to_string(),
            trials: 4,
            timeout_ms: 1_000,
            run_benchmark: true,
            public_ipv4_hint: None,
            custom_dns_ip: None,
        }
    }
}

impl DnsBenchOptions {
    #[must_use]
    pub fn with_custom_dns(mut self, dns_ip: Option<String>) -> Self {
        self.custom_dns_ip = dns_ip;
        self
    }
}

/// Parsed RFC 1035 NXDOMAIN verification outcome for one DNS wire packet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsNxdomainParseResult {
    pub rcode: u8,
    pub answers_v4: Vec<String>,
    pub hijacked: bool,
}

/// Parsed RFC 1035 / RFC 6891 wire DNS reply supporting A, AAAA, PTR, DNSSEC AD, and EDNS0 OPT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsWireReply {
    pub rcode: u8,
    pub ad_flag: bool,
    pub edns0_present: bool,
    pub answers_v4: Vec<String>,
    pub answers_v6: Vec<String>,
    pub ptr_names: Vec<String>,
}

/// RFC 1035 NXDOMAIN DNS-hijack check summary across configured/public resolvers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NxdomainHijackReport {
    pub status: DataProvenance,
    pub probed_domain: String,
    pub hijacked: bool,
    pub hijack_ips: Vec<String>,
    pub resolvers_tested: Vec<String>,
    pub hijacking_resolvers: Vec<String>,
    pub detail: Option<String>,
}

/// Latency & reliability benchmark result for a single DNS resolver.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResolverBench {
    pub name: String,
    pub server: String,
    pub status: DataProvenance,
    pub min_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub failure_rate_pct: f64,
    pub samples_ms: Vec<f64>,
    pub resolved_ip: Option<String>,
    #[serde(default)]
    pub hijack_detected: bool,
    #[serde(default)]
    pub uncached_ms: Option<f64>,
    #[serde(default)]
    pub cached_ms: Option<f64>,
    #[serde(default)]
    pub dnssec_ad: bool,
    #[serde(default)]
    pub edns0_supported: bool,
    #[serde(default)]
    pub aaaa_supported: bool,
    #[serde(default)]
    pub aaaa_answers: Vec<String>,
}

/// System DNS configuration, multi-resolver benchmark, DoH/DoT audit, and VPN leak assessment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsIntelReport {
    pub system_dns_servers: Vec<String>,
    pub search_suffixes: Vec<String>,
    pub hosts_override_count: usize,
    pub hosts_sample_domains: Vec<String>,
    pub resolvers: Vec<DnsResolverBench>,
    pub fastest_resolver: Option<String>,
    pub dns_egress_ip: Option<String>,
    pub vpn_active: bool,
    pub leak_status: String,
    pub leak_warning: Option<String>,
    pub observed_at_ms: i64,
    #[serde(default)]
    pub nxdomain_hijack: Option<NxdomainHijackReport>,
    #[serde(default)]
    pub doh_enabled: bool,
    #[serde(default)]
    pub doh_status: String,
    #[serde(default)]
    pub doh_templates: Vec<String>,
    #[serde(default)]
    pub dot_enabled: bool,
    #[serde(default)]
    pub dot_status: String,
}

/// Masked environment proxy configuration entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvProxyEntry {
    pub name: String,
    pub value_masked: String,
}

/// Windows WinINET / WinHTTP / PAC proxy configuration (credentials masked).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyConfig {
    pub auto_detect: bool,
    pub pac_url: Option<String>,
    pub ie_proxy_server: Option<String>,
    pub ie_proxy_bypass: Option<String>,
    pub winhttp_access_type: String,
    pub winhttp_proxy: Option<String>,
    pub winhttp_bypass: Option<String>,
}

/// Detected loopback proxy listener hint with process attribution & risk assessment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyHint {
    pub port: u16,
    pub label: String,
    pub listening: bool,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub process_name: Option<String>,
    #[serde(default)]
    pub suspected_tool: Option<String>,
    #[serde(default = "default_risk_low")]
    pub risk: String,
}

/// Target specification for passive upstream endpoint waterfall + TLS inspection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbeTarget {
    pub id: String,
    pub label: String,
    pub url: String,
}

/// Four-stage `DNS -> TCP -> TLS -> TTFB` waterfall plus TLS chain / MITM-CA inspection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointWaterfall {
    pub id: String,
    pub label: String,
    pub url: String,
    pub host: String,
    pub provenance: DataProvenance,
    pub dns_ms: Option<f64>,
    pub tcp_ms: Option<f64>,
    pub tls_ms: Option<f64>,
    pub ttfb_ms: Option<f64>,
    pub total_ms: Option<f64>,
    pub http_status: Option<u16>,
    pub tls_version: Option<String>,
    pub cipher_strength_bits: Option<u32>,
    pub cert_subject: Option<String>,
    pub cert_issuer: Option<String>,
    pub cert_not_before: Option<String>,
    pub cert_not_after: Option<String>,
    pub cert_days_remaining: Option<i64>,
    pub mitm_ca_suspected: bool,
    pub mitm_ca_reason: Option<String>,
    pub error: Option<String>,
    pub observed_at_ms: i64,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub resolved_ip: Option<String>,
    #[serde(default)]
    pub http_version: Option<String>,
    #[serde(default)]
    pub alpn: Option<String>,
    #[serde(default)]
    pub chain_depth: Option<u32>,
    #[serde(default)]
    pub root_issuer: Option<String>,
    #[serde(default)]
    pub leaf_sha256: Option<String>,
}

/// Combined Proxy, PAC, Local Proxy Hints, and Upstream Endpoint Waterfall + TLS Chain report.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTlsReport {
    pub env_proxies: Vec<EnvProxyEntry>,
    pub system_proxy: SystemProxyConfig,
    pub local_proxy_ports: Vec<LocalProxyHint>,
    pub endpoints: Vec<EndpointWaterfall>,
    pub mitm_warning: Option<String>,
    pub observed_at_ms: i64,
    #[serde(default)]
    pub pac_reachable: Option<bool>,
    #[serde(default)]
    pub pac_bytes: Option<u64>,
    #[serde(default)]
    pub proxy_overhead_ms: Option<f64>,
}

/// Result of a targeted custom TLS host certificate & chain inspection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsHostProbeReport {
    pub host: String,
    pub port: u16,
    pub provenance: DataProvenance,
    pub tls_version: Option<String>,
    pub alpn: Option<String>,
    pub http_version: Option<String>,
    pub cipher_strength_bits: Option<u32>,
    pub cert_subject: Option<String>,
    pub cert_issuer: Option<String>,
    pub root_issuer: Option<String>,
    pub chain_depth: Option<u32>,
    pub leaf_sha256: Option<String>,
    pub cert_not_before: Option<String>,
    pub cert_not_after: Option<String>,
    pub cert_days_remaining: Option<i64>,
    pub mitm_ca_suspected: bool,
    pub mitm_ca_reason: Option<String>,
    pub resolved_ip: Option<String>,
    pub dns_ms: Option<f64>,
    pub tcp_ms: Option<f64>,
    pub ttfb_ms: Option<f64>,
    pub error: Option<String>,
    pub observed_at_ms: i64,
}

/// Single region probe inside [`GlobalRadarReport`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalRadarRegion {
    pub id: String,
    pub region: String,
    pub label: String,
    pub host: String,
    pub endpoint: String,
    pub status: DataProvenance,
    pub rtt_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub http_status: Option<u16>,
    pub error: Option<String>,
}

/// Six-region global latency radar across US, Europe, Asia, and Oceania.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalRadarReport {
    pub provenance: DataProvenance,
    pub observed_at_ms: i64,
    pub regions: Vec<GlobalRadarRegion>,
}

/// Single parsed hop from [`run_bounded_traceroute`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteHop {
    pub hop: u8,
    pub ip: Option<String>,
    pub host: Option<String>,
    pub rtt_ms: Option<f64>,
    pub rtts_ms: Vec<Option<f64>>,
    pub timed_out: bool,
    pub raw: String,
}

/// Bounded network path traceroute result (`<= 12` hops).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteReport {
    pub target: String,
    pub max_hops: u8,
    pub reached: bool,
    pub hops: Vec<TracerouteHop>,
    pub duration_ms: u64,
    pub provenance: DataProvenance,
    pub error: Option<String>,
}

/// Single passive network monitor sample held in [`PassiveMonitorState`] ring buffer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassiveMonitorSample {
    pub timestamp_ms: i64,
    pub ping_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub loss_pct: f64,
    pub rx_bps: u64,
    pub tx_bps: u64,
    pub quality: String,
}

/// Snapshot view returned by [`PassiveMonitorState::snapshot`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassiveMonitorSnapshot {
    pub running: bool,
    pub active: bool,
    pub interval_ms: u64,
    pub target: String,
    pub capacity: usize,
    pub sample_count: usize,
    pub samples: Vec<PassiveMonitorSample>,
}

/// Thread-safe 120-sample passive latency, loss, and NIC throughput background monitor.
pub struct PassiveMonitorState {
    capacity: usize,
    running: Arc<AtomicBool>,
    interval_ms: Arc<AtomicU64>,
    target: Arc<Mutex<String>>,
    samples: Arc<Mutex<std::collections::VecDeque<PassiveMonitorSample>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// Configuration for an on-demand cancellable Speedtest & Bufferbloat run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestConfig {
    /// Profile: `"quick"`, `"standard"`, or `"exhaustive"`.
    pub profile: String,
    /// Optional base URL override (e.g. `http://127.0.0.1:<port>` for offline unit/E2E tests).
    /// Defaults to Cloudflare's unauthenticated speed endpoint (`https://speed.cloudflare.com`).
    pub base_url_override: Option<String>,
    /// Number of unloaded RTT probe samples (10 quick / 16 standard / 24 exhaustive).
    pub unloaded_samples: usize,
    /// Concurrent streams for multi-stream DL/UL phase (clamped `1..=6`, default `4`).
    pub multi_streams: usize,
    /// Per-phase duration cap in milliseconds (clamped `800..=8000`).
    pub phase_duration_ms: u64,
    /// Stream concurrency mode: `"multi"` (single+multi) or `"single"` (single-stream focus).
    #[serde(default = "default_stream_mode")]
    pub stream_mode: String,
}

impl Default for SpeedtestConfig {
    fn default() -> Self {
        Self::for_profile("standard")
    }
}

impl SpeedtestConfig {
    #[must_use]
    pub fn for_profile(profile: &str) -> Self {
        let lower = profile.trim().to_ascii_lowercase();
        let (canonical, unloaded_samples, multi_streams, phase_duration_ms) = match lower.as_str() {
            "quick" => ("quick", 10usize, 4usize, 2_200u64),
            "exhaustive" | "full" | "pro" => ("exhaustive", 24usize, 6usize, 5_500u64),
            _ => ("standard", 16usize, 4usize, 3_800u64),
        };
        Self {
            profile: canonical.to_string(),
            base_url_override: None,
            unloaded_samples,
            multi_streams,
            phase_duration_ms,
            stream_mode: default_stream_mode(),
        }
    }

    #[must_use]
    pub fn with_stream_mode(mut self, mode: &str) -> Self {
        let is_single = mode.trim().eq_ignore_ascii_case("single");
        self.stream_mode = if is_single { "single" } else { "multi" }.to_string();
        if is_single {
            self.multi_streams = 1;
        }
        self
    }
}

/// Live waveform sample emitted during download / upload speedtest phases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPoint {
    pub elapsed_ms: u64,
    pub phase: String,
    pub streams: usize,
    pub mbps: f64,
    pub loaded_rtt_ms: Option<f64>,
}

/// Live progress event delivered via callback (and forwarded to WS/SSE/TUI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestProgressEvent {
    pub run_id: String,
    pub phase: String,
    pub progress_pct: u8,
    pub current_mbps: Option<f64>,
    pub current_rtt_ms: Option<f64>,
    pub unloaded_p50_ms: Option<f64>,
    pub bufferbloat_delta_ms: Option<f64>,
    pub sample: Option<WaveformPoint>,
    pub message: String,
    pub timestamp_ms: i64,
}

/// Latency distribution summary for unloaded or loaded speedtest probes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStats {
    pub samples: usize,
    pub min_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub loss_pct: f64,
}

/// Single workload readiness score (`0..=100`) and rating label.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadScore {
    pub score: u8,
    pub rating: String,
    pub rationale: String,
}

/// Workload readiness breakdown across Omnia's core and 5-workload Pro Matrix profiles.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadReadinessScores {
    pub ai_sse_streaming: WorkloadScore,
    pub git_docker_sync: WorkloadScore,
    pub webrtc: WorkloadScore,
    pub remote_control: WorkloadScore,
    #[serde(default)]
    pub coding_ai: WorkloadScore,
    #[serde(default)]
    pub streaming_4k: WorkloadScore,
    #[serde(default)]
    pub video_calls: WorkloadScore,
    #[serde(default)]
    pub gaming: WorkloadScore,
    #[serde(default)]
    pub large_sync: WorkloadScore,
}

/// Final persisted Speedtest + Bufferbloat result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    pub run_id: String,
    pub profile: String,
    pub endpoint: String,
    pub provenance: DataProvenance,
    pub cancelled: bool,
    pub unloaded: LatencyStats,
    pub loaded_download: LatencyStats,
    pub loaded_upload: LatencyStats,
    pub single_stream_dl_mbps: f64,
    pub multi_stream_dl_mbps: f64,
    pub download_mbps: f64,
    pub single_stream_ul_mbps: f64,
    pub multi_stream_ul_mbps: f64,
    pub upload_mbps: f64,
    pub dl_bufferbloat_delta_ms: f64,
    pub ul_bufferbloat_delta_ms: f64,
    pub worst_bufferbloat_delta_ms: f64,
    pub bufferbloat_grade: String,
    pub workload_readiness: WorkloadReadinessScores,
    pub waveform: Vec<WaveformPoint>,
    pub duration_ms: u64,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    pub error: Option<String>,
    #[serde(default = "default_stream_mode")]
    pub stream_mode: String,
    #[serde(default)]
    pub sustained_dl_mbps: f64,
    #[serde(default)]
    pub sustained_ul_mbps: f64,
    #[serde(default)]
    pub dl_cv_pct: f64,
    #[serde(default)]
    pub ul_cv_pct: f64,
    #[serde(default)]
    pub ipv4_ping_ms: Option<f64>,
    #[serde(default)]
    pub ipv6_ping_ms: Option<f64>,
}

// =========================================================================
// Time & Math Helpers
// =========================================================================

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Computes a linear-interpolated percentile (`p` in `0.0..=100.0`) from `values`.
#[must_use]
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    let mut clean: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if clean.is_empty() {
        return None;
    }
    clean.sort_by(|a, b| a.total_cmp(b));
    let pct = p.clamp(0.0, 100.0) / 100.0;
    let idx = pct * ((clean.len() - 1) as f64);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        Some(round2(clean[lo]))
    } else {
        let frac = idx - (lo as f64);
        Some(round2(clean[lo] + (clean[hi] - clean[lo]) * frac))
    }
}

/// Computes RFC-3550 smoothed inter-arrival jitter (`J <- J + (|D| - J) / 16`) over RTT samples.
#[must_use]
pub fn rfc3550_jitter_ms(samples: &[f64]) -> Option<f64> {
    if samples.len() < 2 {
        return samples.first().map(|_| 0.0);
    }
    let mut jitter = 0.0f64;
    for pair in samples.windows(2) {
        let diff = (pair[1] - pair[0]).abs();
        jitter += (diff - jitter) / 16.0;
    }
    Some(round2(jitter))
}

fn summarize_latency(samples: &[f64], attempted: usize) -> LatencyStats {
    let loss_pct = if attempted == 0 {
        0.0
    } else {
        let lost = attempted.saturating_sub(samples.len());
        round2((lost as f64 / attempted as f64) * 100.0)
    };
    let min_ms = samples
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .reduce(f64::min)
        .map(round2);
    let max_ms = samples
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .reduce(f64::max)
        .map(round2);
    LatencyStats {
        samples: samples.len(),
        min_ms,
        p50_ms: percentile(samples, 50.0),
        p95_ms: percentile(samples, 95.0),
        p99_ms: percentile(samples, 99.0),
        max_ms,
        jitter_ms: rfc3550_jitter_ms(samples),
        loss_pct,
    }
}

/// Assigns Waveform/DSLReports Bufferbloat Grade (`A+`, `A`, `B`, `C`, `D`, `F`) from `+ms` delta.
#[must_use]
pub fn grade_bufferbloat(delta_ms: f64) -> &'static str {
    if !delta_ms.is_finite() || delta_ms < 0.0 {
        return "A+";
    }
    if delta_ms <= 5.0 {
        "A+"
    } else if delta_ms <= 30.0 {
        "A"
    } else if delta_ms <= 60.0 {
        "B"
    } else if delta_ms <= 200.0 {
        "C"
    } else if delta_ms <= 400.0 {
        "D"
    } else {
        "F"
    }
}

/// Computes coefficient of variation (`stddev / mean * 100.0`) clamped to `[0.0, 999.9]`.
#[must_use]
pub fn compute_cv_pct(samples: &[f64]) -> f64 {
    let clean: Vec<f64> = samples
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .collect();
    if clean.len() < 2 {
        return 0.0;
    }
    let n = clean.len() as f64;
    let mean = clean.iter().sum::<f64>() / n;
    if mean <= 0.0 {
        return 0.0;
    }
    let var = clean
        .iter()
        .map(|v| {
            let d = *v - mean;
            d * d
        })
        .sum::<f64>()
        / n;
    round2(((var.sqrt() / mean) * 100.0).min(999.9))
}

/// Computes sustained throughput (interquartile trimmed median of steady-state waveform samples).
#[must_use]
pub fn compute_sustained_mbps(samples: &[f64]) -> f64 {
    let mut clean: Vec<f64> = samples
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .collect();
    if clean.is_empty() {
        return 0.0;
    }
    clean.sort_by(|a, b| a.total_cmp(b));
    let n = clean.len();
    if n < 4 {
        return percentile(&clean, 50.0).unwrap_or(0.0);
    }
    let lo = n / 4;
    let hi = (n * 3) / 4;
    let slice = if hi > lo { &clean[lo..hi] } else { &clean[..] };
    round2(slice.iter().sum::<f64>() / (slice.len() as f64))
}

/// Computes Workload Readiness Scores (`0..=100`) across Omnia's core and 5-workload Pro profiles.
#[must_use]
pub fn compute_workload_readiness(
    unloaded: &LatencyStats,
    dl_mbps: f64,
    ul_mbps: f64,
    dl_delta_ms: f64,
    ul_delta_ms: f64,
) -> WorkloadReadinessScores {
    let rtt = unloaded.p50_ms.unwrap_or(120.0);
    let p99 = unloaded.p99_ms.unwrap_or(rtt * 1.5);
    let jitter = unloaded.jitter_ms.unwrap_or(15.0);
    let loss = unloaded.loss_pct;
    let worst_bloat = dl_delta_ms.max(ul_delta_ms);

    let rating = |s: u8| -> String {
        if s >= 85 {
            "Excellent".to_string()
        } else if s >= 70 {
            "Good".to_string()
        } else if s >= 50 {
            "Fair".to_string()
        } else {
            "Degraded".to_string()
        }
    };

    // 1. Coding / AI SSE Streaming: low RTT, low jitter, zero loss, DL bloat, >=10 Mbps.
    let mut ai = 100.0f64;
    ai -= ((rtt - 35.0).max(0.0) * 0.25).min(30.0);
    ai -= (jitter * 1.2).min(20.0);
    ai -= (loss * 12.0).min(35.0);
    ai -= ((dl_delta_ms - 25.0).max(0.0) * 0.15).min(25.0);
    if dl_mbps < 10.0 {
        ai -= ((10.0 - dl_mbps) * 2.5).min(20.0);
    }
    let ai_score = ai.clamp(0.0, 100.0).round() as u8;
    let ai_ws = WorkloadScore {
        score: ai_score,
        rating: rating(ai_score),
        rationale: format!(
            "RTT p50 {:.1} ms, jitter {:.1} ms, DL bloat +{:.1} ms, loss {:.1}%",
            rtt, jitter, dl_delta_ms, loss
        ),
    };

    // 2. Large Sync / Git / Docker Sync: multi-stream DL + UL throughput + packet loss.
    let dl_pts = (dl_mbps / 100.0).min(1.0) * 55.0;
    let ul_pts = (ul_mbps / 40.0).min(1.0) * 35.0;
    let loss_pen = (loss * 10.0).min(30.0);
    let git_score = (10.0 + dl_pts + ul_pts - loss_pen).clamp(0.0, 100.0).round() as u8;
    let git_ws = WorkloadScore {
        score: git_score,
        rating: rating(git_score),
        rationale: format!(
            "DL {:.1} Mbps / UL {:.1} Mbps, loss {:.1}%",
            dl_mbps, ul_mbps, loss
        ),
    };

    // 3. Video Calls / WebRTC: jitter, loss, bufferbloat, and UL >= 5 Mbps.
    let mut rtc = 100.0f64;
    rtc -= ((rtt - 40.0).max(0.0) * 0.2).min(20.0);
    rtc -= (jitter * 2.0).min(25.0);
    rtc -= (loss * 18.0).min(40.0);
    rtc -= ((worst_bloat - 20.0).max(0.0) * 0.22).min(30.0);
    if ul_mbps < 5.0 {
        rtc -= ((5.0 - ul_mbps) * 4.0).min(20.0);
    }
    let rtc_score = rtc.clamp(0.0, 100.0).round() as u8;
    let rtc_ws = WorkloadScore {
        score: rtc_score,
        rating: rating(rtc_score),
        rationale: format!(
            "Jitter {:.1} ms, worst bloat +{:.1} ms, UL {:.1} Mbps",
            jitter, worst_bloat, ul_mbps
        ),
    };

    // 4. Remote Control: ultra-sensitive to p99 latency, jitter, loss, and UL bloat.
    let mut rc = 100.0f64;
    rc -= ((p99 - 35.0).max(0.0) * 0.25).min(30.0);
    rc -= (jitter * 2.2).min(25.0);
    rc -= (loss * 20.0).min(45.0);
    rc -= ((worst_bloat - 15.0).max(0.0) * 0.25).min(35.0);
    if ul_mbps < 8.0 {
        rc -= ((8.0 - ul_mbps) * 2.5).min(15.0);
    }
    let rc_score = rc.clamp(0.0, 100.0).round() as u8;
    let rc_ws = WorkloadScore {
        score: rc_score,
        rating: rating(rc_score),
        rationale: format!(
            "p99 RTT {:.1} ms, worst bloat +{:.1} ms, loss {:.1}%",
            p99, worst_bloat, loss
        ),
    };

    // 5. 4K Streaming: sustained download >= 25 Mbps, zero loss, minimal DL bufferbloat stall.
    let mut s4k = 100.0f64;
    if dl_mbps < 35.0 {
        s4k -= ((35.0 - dl_mbps) * 1.8).min(50.0);
    }
    s4k -= (loss * 14.0).min(35.0);
    s4k -= ((dl_delta_ms - 60.0).max(0.0) * 0.12).min(20.0);
    s4k -= (jitter * 0.6).min(12.0);
    let s4k_score = s4k.clamp(0.0, 100.0).round() as u8;
    let s4k_ws = WorkloadScore {
        score: s4k_score,
        rating: rating(s4k_score),
        rationale: format!(
            "DL {:.1} Mbps (25+ Mbps target), DL bloat +{:.1} ms, loss {:.1}%",
            dl_mbps, dl_delta_ms, loss
        ),
    };

    // 6. Gaming / Interactive: ultra-low baseline RTT, jitter <= 8 ms, zero loss, minimal bloat.
    let mut gm = 100.0f64;
    gm -= ((rtt - 25.0).max(0.0) * 0.45).min(35.0);
    gm -= ((p99 - 45.0).max(0.0) * 0.2).min(20.0);
    gm -= (jitter * 2.5).min(25.0);
    gm -= (loss * 25.0).min(50.0);
    gm -= ((worst_bloat - 12.0).max(0.0) * 0.30).min(35.0);
    let gm_score = gm.clamp(0.0, 100.0).round() as u8;
    let gm_ws = WorkloadScore {
        score: gm_score,
        rating: rating(gm_score),
        rationale: format!(
            "p50/p99 {:.1}/{:.1} ms, jitter {:.1} ms, bloat +{:.1} ms, loss {:.1}%",
            rtt, p99, jitter, worst_bloat, loss
        ),
    };

    WorkloadReadinessScores {
        ai_sse_streaming: ai_ws.clone(),
        git_docker_sync: git_ws.clone(),
        webrtc: rtc_ws.clone(),
        remote_control: rc_ws,
        coding_ai: ai_ws,
        streaming_4k: s4k_ws,
        video_calls: rtc_ws,
        gaming: gm_ws,
        large_sync: git_ws,
    }
}

/// Masks embedded `user:pass@` credentials in proxy URLs as `user:***@`.
#[must_use]
pub fn mask_proxy_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Some(scheme_pos) = trimmed.find("://") else {
        // Handle `user:pass@host:port` without scheme
        if let Some(at) = trimmed.find('@') {
            let auth = &trimmed[..at];
            let host = &trimmed[at + 1..];
            if let Some((user, _)) = auth.split_once(':') {
                return format!("{user}:***@{host}");
            }
            return format!("***@{host}");
        }
        return trimmed.to_string();
    };
    let scheme = &trimmed[..scheme_pos + 3];
    let rest = &trimmed[scheme_pos + 3..];
    let slash_pos = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..slash_pos];
    let path = &rest[slash_pos..];
    let Some(at) = authority.rfind('@') else {
        return trimmed.to_string();
    };
    let userinfo = &authority[..at];
    let host = &authority[at + 1..];
    if let Some((user, _pass)) = userinfo.split_once(':') {
        format!("{scheme}{user}:***@{host}{path}")
    } else {
        format!("{scheme}***@{host}{path}")
    }
}

/// Detects VPN / TUN / virtual adapter categories from adapter name and description.
#[must_use]
pub fn classify_vpn_adapter(name: &str, description: &str, if_type: u32) -> Option<String> {
    let hay = format!("{} {}", name.to_ascii_lowercase(), description.to_ascii_lowercase());
    if hay.contains("wireguard") || hay.contains("wintun") {
        Some("WireGuard / WinTun".to_string())
    } else if hay.contains("tailscale") {
        Some("Tailscale".to_string())
    } else if hay.contains("cloudflare") || hay.contains("warp") {
        Some("Cloudflare WARP".to_string())
    } else if hay.contains("clash") || hay.contains("mihomo") || hay.contains("sing-box") || hay.contains("meta") && hay.contains("tun") {
        Some("Clash / TUN Proxy".to_string())
    } else if hay.contains("adguard") {
        Some("AdGuard VPN/Filter".to_string())
    } else if hay.contains("wsl") || hay.contains("vethernet") || hay.contains("hyper-v") {
        Some("WSL / vEthernet".to_string())
    } else if hay.contains("openvpn") || hay.contains("tap-windows") || hay.contains("proton") || hay.contains("nordlynx") {
        Some("VPN / TAP Tunnel".to_string())
    } else if if_type == 53 || if_type == 131 {
        // IF_TYPE_PROP_VIRTUAL (53) or IF_TYPE_TUNNEL (131)
        Some("Virtual Tunnel".to_string())
    } else {
        None
    }
}

/// Classifies NAT / CGNAT posture from local non-loopback IPv4 addresses and public IPv4.
#[must_use]
pub fn classify_nat(local_ipv4s: &[Ipv4Addr], public_ipv4: Option<Ipv4Addr>, vpn_active: bool) -> String {
    if vpn_active {
        return "VPN / Tunnel Active".to_string();
    }
    let has_cgnat = local_ipv4s.iter().any(|ip| {
        let o = ip.octets();
        o[0] == 100 && (64..=127).contains(&o[1])
    });
    if has_cgnat {
        return "CGNAT Suspected (100.64.0.0/10)".to_string();
    }
    if let Some(pub_ip) = public_ipv4 {
        if local_ipv4s.contains(&pub_ip) {
            return "Direct Public IPv4".to_string();
        }
        if local_ipv4s.iter().any(|ip| ip.is_private()) {
            return "Behind NAT (RFC 1918)".to_string();
        }
        return "Translated / Edge NAT".to_string();
    }
    if local_ipv4s.iter().any(|ip| ip.is_private()) {
        "Local RFC 1918 (Public IP Unavailable)".to_string()
    } else {
        "Unknown".to_string()
    }
}

/// Checks certificate issuer for known local MITM / TLS-inspection proxies.
#[must_use]
pub fn detect_mitm_ca(issuer: &str) -> Option<String> {
    let lower = issuer.to_ascii_lowercase();
    for (needle, label) in [
        ("adguard", "AdGuard Local HTTPS Filtering CA"),
        ("fiddler", "Fiddler Debugging Proxy CA"),
        ("charles", "Charles Proxy CA"),
        ("mitmproxy", "mitmproxy Local CA"),
        ("burp", "PortSwigger Burp CA"),
        ("zscaler", "Zscaler Enterprise Inspection CA"),
        ("netskope", "Netskope Enterprise Inspection CA"),
        ("fortinet", "Fortinet Inspection CA"),
        ("kaspersky", "Kaspersky Web Scan CA"),
        ("avast", "Avast/AVG Web Shield CA"),
        ("eset", "ESET SSL/TLS Filtering CA"),
        ("mkcert", "mkcert Local Development CA"),
    ] {
        if lower.contains(needle) {
            return Some(label.to_string());
        }
    }
    None
}

/// Computes a deterministic SHA-256 Network Fingerprint over active adapter topology and egress.
#[must_use]
pub fn compute_network_fingerprint(
    adapters: &[NicAdapterInfo],
    public_ipv4: Option<&str>,
    public_ipv6: Option<&str>,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for a in adapters {
        if a.status != "up" || a.kind == "loopback" {
            continue;
        }
        let mut v4 = a.ipv4_cidrs.clone();
        v4.sort();
        let mut gw = a.gateways.clone();
        gw.sort();
        let mut dns = a.dns_servers.clone();
        dns.sort();
        lines.push(format!(
            "{}|{}|{}|{}|{}",
            a.name,
            v4.join(","),
            gw.join(","),
            dns.join(","),
            a.vpn_tag.as_deref().unwrap_or("")
        ));
    }
    lines.sort();
    lines.push(format!("pub4={}", public_ipv4.unwrap_or("unavailable")));
    lines.push(format!("pub6={}", public_ipv6.unwrap_or("unavailable")));
    let mut hasher = Sha256::new();
    hasher.update(lines.join("\n").as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

/// Default passive upstream probe targets (9 categorized endpoints; strictly excludes `agy` & OAuth).
#[must_use]
pub fn default_upstream_targets() -> Vec<EndpointProbeTarget> {
    vec![
        EndpointProbeTarget {
            id: "cloudflare".to_string(),
            label: "Cloudflare Edge".to_string(),
            url: "https://1.1.1.1/cdn-cgi/trace".to_string(),
        },
        EndpointProbeTarget {
            id: "github".to_string(),
            label: "GitHub API".to_string(),
            url: "https://api.github.com/zen".to_string(),
        },
        EndpointProbeTarget {
            id: "npm".to_string(),
            label: "npm Registry".to_string(),
            url: "https://registry.npmjs.org/-/ping".to_string(),
        },
        EndpointProbeTarget {
            id: "crates_io".to_string(),
            label: "crates.io Registry".to_string(),
            url: "https://crates.io/api/v1/summary".to_string(),
        },
        EndpointProbeTarget {
            id: "pypi".to_string(),
            label: "PyPI Registry".to_string(),
            url: "https://pypi.org/pypi/pip/json".to_string(),
        },
        EndpointProbeTarget {
            id: "huggingface".to_string(),
            label: "HuggingFace API".to_string(),
            url: "https://huggingface.co/api/models?limit=1".to_string(),
        },
        EndpointProbeTarget {
            id: "google_apis".to_string(),
            label: "Google Gemini API".to_string(),
            url: "https://generativelanguage.googleapis.com/".to_string(),
        },
        EndpointProbeTarget {
            id: "openai".to_string(),
            label: "OpenAI API".to_string(),
            url: "https://api.openai.com/v1/models".to_string(),
        },
        EndpointProbeTarget {
            id: "anthropic".to_string(),
            label: "Anthropic API".to_string(),
            url: "https://api.anthropic.com/v1/messages".to_string(),
        },
    ]
}

/// Classifies an upstream probe endpoint into UI/CLI categories.
#[must_use]
pub fn classify_endpoint_category(id: &str, label: &str, host: &str) -> String {
    let key = format!(
        "{} {} {}",
        id.to_ascii_lowercase(),
        label.to_ascii_lowercase(),
        host.to_ascii_lowercase()
    );
    if key.contains("openai")
        || key.contains("anthropic")
        || key.contains("google")
        || key.contains("gemini")
        || key.contains("hugging")
        || key.contains("htmustc")
        || key.contains("provider:")
    {
        "AI / Model".to_string()
    } else if key.contains("github")
        || key.contains("npm")
        || key.contains("crates")
        || key.contains("pypi")
    {
        "Registry / Git".to_string()
    } else if key.contains("cloudflare") || key == "1.1.1.1" {
        "Edge / CDN".to_string()
    } else {
        "Custom / Net".to_string()
    }
}

fn is_forbidden_probe_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("agy")
        || lower.contains("antigravity")
        || lower.contains("accounts.google.com")
        || lower.contains("oauth2.googleapis.com")
        || lower.contains("169.254.169.254")
        || lower.contains("metadata.google.internal")
        || lower.contains("metadata.azure.com")
        || lower.contains("100.100.100.200")
        || lower.contains("fd00:ec2::254")
}

/// Validates a custom host or URL target against SSRF, CLI flag injection, and forbidden OAuth/IMDS endpoints.
pub fn validate_probe_host(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err("Target host must be 1..=253 characters.".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("Target host must not begin with '-'.".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, ';' | '&' | '|' | '$' | '`' | '<' | '>' | '(' | ')' | '\\' | '"' | '\'' | '{' | '}' | '*' | '?'))
    {
        return Err("Target host contains forbidden shell or whitespace characters.".to_string());
    }
    if is_forbidden_probe_url(trimmed) {
        return Err("Target blocked by policy (agy/OAuth/IMDS probes forbidden).".to_string());
    }
    let host_only = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed)
        .split('/')
        .next()
        .unwrap_or("")
        .trim();
    let bare = if let Some(inner) = host_only.strip_prefix('[') {
        inner
            .split(']')
            .next()
            .unwrap_or("")
    } else if host_only.matches(':').count() == 1 {
        host_only.split(':').next().unwrap_or("")
    } else {
        host_only
    };
    if bare.is_empty() {
        return Err("Target hostname is empty.".to_string());
    }
    if bare.eq_ignore_ascii_case("localhost") {
        return Err("Loopback host 'localhost' rejected by SSRF guard.".to_string());
    }
    if let Ok(ip) = bare.parse::<IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
            return Err("Loopback, unspecified, or multicast IP rejected by SSRF guard.".to_string());
        }
        if let IpAddr::V4(v4) = ip {
            if v4.is_link_local() {
                return Err("Link-local IPv4 rejected by SSRF guard.".to_string());
            }
        }
        return Ok(trimmed.to_string());
    }
    if !bare
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err("Hostname contains invalid characters.".to_string());
    }
    if bare.starts_with('.') || bare.ends_with('.') || bare.contains("..") {
        return Err("Malformed hostname labels.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Normalizes a validated custom host or URL into an [`EndpointProbeTarget`] (HTTPS default).
pub fn normalize_custom_probe_url(raw: &str) -> Result<EndpointProbeTarget, String> {
    let valid = validate_probe_host(raw)?;
    let url = if valid.starts_with("https://") || valid.starts_with("http://") {
        valid.clone()
    } else {
        format!("https://{valid}/")
    };
    let (_, host, _, _) = parse_url_parts(&url)?;
    if is_forbidden_probe_url(&url) {
        return Err("Target blocked by policy (agy/OAuth/IMDS probes forbidden).".to_string());
    }
    Ok(EndpointProbeTarget {
        id: "custom".to_string(),
        label: format!("Custom ({host})"),
        url,
    })
}

/// Validates and extracts a bare hostname or IP literal suitable for `tracert` / `tls-probe`.
pub fn validate_bare_target_host(raw: &str) -> Result<String, String> {
    let valid = validate_probe_host(raw)?;
    let host_only = valid
        .strip_prefix("https://")
        .or_else(|| valid.strip_prefix("http://"))
        .unwrap_or(&valid)
        .split('/')
        .next()
        .unwrap_or("")
        .trim();
    let bare = if let Some(inner) = host_only.strip_prefix('[') {
        inner.split(']').next().unwrap_or("").to_string()
    } else if host_only.matches(':').count() == 1 {
        host_only
            .split(':')
            .next()
            .unwrap_or("")
            .to_string()
    } else {
        host_only.to_string()
    };
    if bare.is_empty() {
        return Err("Hostname is empty.".to_string());
    }
    Ok(bare)
}

// =========================================================================
// 1. Network Identity, Interfaces, Wi-Fi RF, VPN/CGNAT & Live Traffic
// =========================================================================

struct CachedPublicNet {
    fetched_at: Instant,
    ipv4: Option<String>,
    ipv6: Option<String>,
    geo: Option<GeoIpInfo>,
    ptr: Option<String>,
    warp_status: Option<String>,
}

type NicCounterCache = Mutex<HashMap<u32, (u64, u64, Instant)>>;

static PUBLIC_NET_CACHE: OnceLock<Mutex<Option<CachedPublicNet>>> = OnceLock::new();
static WATERFALL_CACHE: OnceLock<Mutex<Option<(Instant, ProxyTlsReport)>>> = OnceLock::new();
static NIC_COUNTER_CACHE: OnceLock<NicCounterCache> = OnceLock::new();

/// Classifies local non-loopback IPv4 posture (`RFC6598_CGNAT` | `PUBLIC` | `RFC1918` | `LINK_LOCAL` | `UNKNOWN`)
/// and extracts concrete CGNAT evidence.
#[must_use]
pub fn classify_local_ip_and_cgnat(
    adapters: &[NicAdapterInfo],
    stun: Option<&StunProbeReport>,
    public_ipv4: Option<Ipv4Addr>,
) -> (String, Option<String>) {
    let mut non_vpn_v4: Vec<Ipv4Addr> = Vec::new();
    let mut vpn_cgnat_v4: Vec<(String, Ipv4Addr)> = Vec::new();
    let mut non_vpn_cgnat: Option<Ipv4Addr> = None;

    for a in adapters {
        if a.status != "up" || a.kind == "loopback" {
            continue;
        }
        let is_wsl = a.vpn_tag.as_deref().is_some_and(|t| t.starts_with("WSL"));
        if is_wsl {
            continue;
        }
        let is_vpn = a.vpn_tag.is_some();
        for cidr in &a.ipv4_cidrs {
            let Some(ip) = cidr.split('/').next().and_then(|s| s.parse::<Ipv4Addr>().ok()) else {
                continue;
            };
            if ip.is_loopback() {
                continue;
            }
            let o = ip.octets();
            let in_6598 = o[0] == 100 && (64..=127).contains(&o[1]);
            if is_vpn {
                if in_6598 {
                    vpn_cgnat_v4.push((a.name.clone(), ip));
                }
            } else {
                if in_6598 && non_vpn_cgnat.is_none() {
                    non_vpn_cgnat = Some(ip);
                }
                non_vpn_v4.push(ip);
            }
        }
    }

    if let Some(cgnat_ip) = non_vpn_cgnat {
        return (
            "RFC6598_CGNAT".to_string(),
            Some(format!(
                "Physical/WAN adapter holds {cgnat_ip} inside 100.64.0.0/10 (RFC 6598 carrier-grade NAT)."
            )),
        );
    }

    let has_public_non_vpn = non_vpn_v4
        .iter()
        .any(|ip| !ip.is_private() && !ip.is_link_local() && !ip.is_unspecified());
    let has_rfc1918 = non_vpn_v4.iter().any(|ip| ip.is_private());
    let has_link_local = non_vpn_v4.iter().any(|ip| ip.is_link_local());

    let local_class = if has_public_non_vpn {
        "PUBLIC"
    } else if has_rfc1918 {
        "RFC1918"
    } else if has_link_local {
        "LINK_LOCAL"
    } else if !vpn_cgnat_v4.is_empty() {
        "RFC6598_CGNAT"
    } else {
        "UNKNOWN"
    }
    .to_string();

    let evidence = if let Some((if_name, ip)) = vpn_cgnat_v4.first() {
        Some(format!(
            "Overlay tunnel '{if_name}' uses {ip} (100.64.0.0/10); physical LAN uses {local_class}."
        ))
    } else if let Some(s) = stun {
        if s.status == DataProvenance::Live && s.nat_mapping_behavior == "symmetric_nat" {
            Some("STUN observed symmetric port mapping across probes (NAT/CGNAT traversal constrained).".to_string())
        } else if let (Some(mapped), Some(pub_v4)) = (s.mapped_ip.as_deref(), public_ipv4) {
            if mapped != pub_v4.to_string() {
                Some(format!(
                    "STUN mapped IP ({mapped}) differs from HTTP public egress ({pub_v4})."
                ))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    (local_class, evidence)
}

/// Classifies the network profile heuristically from VPN posture, GeoIP ASN/org, PTR, and IP class.
#[must_use]
pub fn classify_network_type(
    vpn_active: bool,
    warp_active: bool,
    geo: Option<&GeoIpInfo>,
    ptr: Option<&str>,
) -> String {
    if vpn_active || warp_active {
        return "VPN / Privacy".to_string();
    }
    let mut hay = String::new();
    if let Some(g) = geo {
        if let Some(ref org) = g.org {
            hay.push_str(&org.to_ascii_lowercase());
            hay.push(' ');
        }
        if let Some(ref isp) = g.isp {
            hay.push_str(&isp.to_ascii_lowercase());
            hay.push(' ');
        }
        if let Some(ref asn) = g.asn {
            hay.push_str(&asn.to_ascii_lowercase());
            hay.push(' ');
        }
    }
    if let Some(p) = ptr {
        hay.push_str(&p.to_ascii_lowercase());
    }
    let h = hay.trim();
    if h.is_empty() {
        return "Unknown".to_string();
    }
    for kw in [
        "mullvad",
        "proton",
        "nordvpn",
        "expressvpn",
        "surfshark",
        "tailscale",
        "wireguard",
        "cloudflare warp",
        "private internet",
        "vpn",
    ] {
        if h.contains(kw) {
            return "VPN / Privacy".to_string();
        }
    }
    for kw in [
        "mobile",
        "cellular",
        "4g",
        "5g",
        "lte",
        "mobifone",
        "vinaphone",
        "t-mobile",
        "verizon wireless",
        "at&t mobility",
    ] {
        if h.contains(kw) {
            return "Mobile / Cellular".to_string();
        }
    }
    for kw in [
        "amazon",
        "aws",
        "google cloud",
        "microsoft corporation",
        "azure",
        "digitalocean",
        "linode",
        "akamai connected",
        "hetzner",
        "ovh",
        "vultr",
        "oracle",
        "alibaba",
        "tencent",
        "datacenter",
        "hosting",
        "cloud",
        "server",
        "vps",
    ] {
        if h.contains(kw) {
            return "Datacenter / Cloud".to_string();
        }
    }
    for kw in ["university", ".edu", "college", "institute", "research", "enterprise"] {
        if h.contains(kw) {
            return "Enterprise / Edu".to_string();
        }
    }
    "Residential / ISP".to_string()
}

/// Evaluates whether active VPN tunnels carry full default routing or split-tunnel routing.
#[must_use]
pub fn classify_split_tunnel(
    adapters: &[NicAdapterInfo],
    vpn_active: bool,
    warp_active: bool,
    best_v4_if: Option<u32>,
) -> (String, Option<String>) {
    if !vpn_active && !warp_active {
        return (
            "NONE".to_string(),
            Some("No active VPN or WARP tunnel adapter detected.".to_string()),
        );
    }
    let vpn_if_indices: Vec<u32> = adapters
        .iter()
        .filter(|a| {
            a.status == "up"
                && a.if_index != 0
                && a.vpn_tag.as_deref().is_some_and(|t| !t.starts_with("WSL"))
        })
        .map(|a| a.if_index)
        .collect();

    if let Some(best_idx) = best_v4_if {
        if vpn_if_indices.contains(&best_idx) {
            return (
                "FULL_TUNNEL".to_string(),
                Some(format!(
                    "Default IPv4 egress route resolves through active VPN interface index {best_idx}."
                )),
            );
        }
        return (
            "SPLIT_TUNNEL".to_string(),
            Some(format!(
                "VPN adapter active while public default route exits via physical interface index {best_idx}."
            )),
        );
    }

    let vpn_has_gw = adapters.iter().any(|a| {
        a.status == "up"
            && a.vpn_tag.as_deref().is_some_and(|t| !t.starts_with("WSL"))
            && !a.gateways.is_empty()
    });
    let phys_has_gw = adapters.iter().any(|a| {
        a.status == "up" && a.kind != "loopback" && a.vpn_tag.is_none() && !a.gateways.is_empty()
    });
    if warp_active && !phys_has_gw {
        (
            "FULL_TUNNEL".to_string(),
            Some("Cloudflare WARP active with tunnel gateway.".to_string()),
        )
    } else if vpn_has_gw && phys_has_gw {
        (
            "SPLIT_TUNNEL".to_string(),
            Some("Both VPN tunnel and physical interface advertise default gateways.".to_string()),
        )
    } else if vpn_has_gw || warp_active {
        (
            "FULL_TUNNEL".to_string(),
            Some("Active VPN tunnel owns default gateway.".to_string()),
        )
    } else {
        (
            "SPLIT_TUNNEL".to_string(),
            Some("VPN overlay adapter active without overriding physical default gateway.".to_string()),
        )
    }
}

/// Inspects local NICs, live traffic rates, Wi-Fi RF telemetry, VPN/split-tunnel/CGNAT/WARP posture,
/// reverse PTR, deterministic SHA-256 fingerprint, and optional public IPv4/IPv6 + GeoIP/ASN/ISP.
#[must_use]
pub fn inspect_network_identity(opts: &NetDiagOptions) -> NetworkIdentityReport {
    let observed_at_ms = now_epoch_ms();
    let adapters = enumerate_local_adapters();
    let wifi = query_active_wifi();

    let mut total_rx_bps = 0u64;
    let mut total_tx_bps = 0u64;
    for a in &adapters {
        if a.status == "up" && a.kind != "loopback" {
            total_rx_bps = total_rx_bps.saturating_add(a.rx_bps);
            total_tx_bps = total_tx_bps.saturating_add(a.tx_bps);
        }
    }

    let vpn_tags: Vec<String> = adapters
        .iter()
        .filter(|a| a.status == "up")
        .filter_map(|a| a.vpn_tag.clone())
        .filter(|t| !t.starts_with("WSL"))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let vpn_active = !vpn_tags.is_empty();

    let local_ipv4s: Vec<Ipv4Addr> = adapters
        .iter()
        .filter(|a| a.status == "up" && a.kind != "loopback")
        .flat_map(|a| a.ipv4_cidrs.iter())
        .filter_map(|cidr| cidr.split('/').next()?.parse::<Ipv4Addr>().ok())
        .filter(|ip| !ip.is_loopback() && !ip.is_link_local())
        .collect();

    let sys_dns: Vec<String> = adapters
        .iter()
        .filter(|a| a.status == "up")
        .flat_map(|a| a.dns_servers.iter().cloned())
        .collect();

    let (provenance, public_ipv4, public_ipv6, geo, ptr, mut warp_status, detail) =
        if !opts.probe_public_ip {
            (
                DataProvenance::Unavailable,
                None,
                None,
                None,
                None,
                None,
                Some("Public IP probe skipped by option (local adapters only).".to_string()),
            )
        } else {
            probe_public_identity_cached(
                opts.timeout_ms.clamp(500, 6_000),
                opts.force_refresh,
                &sys_dns,
            )
        };

    let warp_adapter = vpn_tags.iter().any(|t| t.contains("WARP"));
    let warp_active = warp_adapter
        || warp_status
            .as_deref()
            .is_some_and(|s| matches!(s, "ON" | "WARP+"));
    if warp_adapter && warp_status.is_none() {
        warp_status = Some("ON".to_string());
    }

    let pub_v4_parsed = public_ipv4
        .as_deref()
        .and_then(|s| s.parse::<Ipv4Addr>().ok());
    let nat_classification = classify_nat(&local_ipv4s, pub_v4_parsed, vpn_active);
    let ipv6_reachable = public_ipv6.is_some();
    let fingerprint_sha256 =
        compute_network_fingerprint(&adapters, public_ipv4.as_deref(), public_ipv6.as_deref());
    let stun = if opts.probe_public_ip {
        Some(probe_stun_nat(
            &local_ipv4s,
            Duration::from_millis(opts.timeout_ms.clamp(300, 2_500)),
        ))
    } else {
        Some(StunProbeReport {
            status: DataProvenance::Unavailable,
            server: None,
            mapped_ip: None,
            mapped_port: None,
            attribute: None,
            nat_mapping_behavior: "skipped_offline".to_string(),
            endpoints_probed: Vec::new(),
            rtt_ms: None,
            error: Some("STUN NAT probe skipped by option (local adapters only).".to_string()),
        })
    };

    let best_v4_if = query_best_ipv4_interface_index();
    let (split_tunnel_mode, split_tunnel_reason) =
        classify_split_tunnel(&adapters, vpn_active, warp_active, best_v4_if);
    let (local_ip_class, cgnat_evidence) =
        classify_local_ip_and_cgnat(&adapters, stun.as_ref(), pub_v4_parsed);
    let network_type =
        classify_network_type(vpn_active, warp_active, geo.as_ref(), ptr.as_deref());

    NetworkIdentityReport {
        provenance,
        public_ipv4,
        public_ipv6,
        ipv6_reachable,
        geo,
        adapters,
        wifi,
        nat_classification,
        vpn_active,
        vpn_tags,
        fingerprint_sha256,
        observed_at_ms,
        detail,
        stun,
        ptr,
        network_type,
        split_tunnel_mode,
        split_tunnel_reason,
        local_ip_class,
        cgnat_evidence,
        warp_active,
        warp_status,
        total_rx_bps,
        total_tx_bps,
    }
}

type PublicIdentityProbeTuple = (
    DataProvenance,
    Option<String>,
    Option<String>,
    Option<GeoIpInfo>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn probe_public_identity_cached(
    timeout_ms: u64,
    force_refresh: bool,
    sys_dns: &[String],
) -> PublicIdentityProbeTuple {
    let cache = PUBLIC_NET_CACHE.get_or_init(|| Mutex::new(None));
    if !force_refresh {
        if let Ok(guard) = cache.lock() {
            if let Some(ref c) = *guard {
                if c.fetched_at.elapsed() < Duration::from_secs(15) {
                    let prov = if c.ipv4.is_some() || c.ipv6.is_some() {
                        DataProvenance::Cached
                    } else {
                        DataProvenance::Unavailable
                    };
                    return (
                        prov,
                        c.ipv4.clone(),
                        c.ipv6.clone(),
                        c.geo.clone(),
                        c.ptr.clone(),
                        c.warp_status.clone(),
                        None,
                    );
                }
            }
        }
    }

    let mut ipv4: Option<String> = None;
    let mut ipv6: Option<String> = None;
    let mut geo: Option<GeoIpInfo> = None;
    let mut warp_status: Option<String> = None;
    let mut last_err: Option<String> = None;

    // 1. Primary unauthenticated metadata probe: Cloudflare speed/meta (returns IP + ASN + ISP + city + country + colo).
    match http_fetch_simple("https://speed.cloudflare.com/meta", "GET", None, timeout_ms) {
        Ok(resp) if (200..300).contains(&resp.status) => {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&resp.body) {
                if let Some(ip_str) = val.get("clientIp").and_then(|v| v.as_str()) {
                    if let Ok(parsed) = ip_str.trim().parse::<IpAddr>() {
                        match parsed {
                            IpAddr::V4(_) => ipv4 = Some(parsed.to_string()),
                            IpAddr::V6(_) => ipv6 = Some(parsed.to_string()),
                        }
                    }
                }
                let asn = val
                    .get("asn")
                    .and_then(|v| v.as_u64().map(|n| format!("AS{n}")).or_else(|| v.as_str().map(ToString::to_string)));
                let org = val
                    .get("asOrganization")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
                let country = val
                    .get("country")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
                let city = val
                    .get("city")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
                let colo = val
                    .get("colo")
                    .and_then(|v| v.as_str())
                    .map(ToString::to_string);
                geo = Some(GeoIpInfo {
                    asn,
                    isp: org.clone(),
                    org,
                    country,
                    city,
                    colo,
                    source: "speed.cloudflare.com/meta".to_string(),
                });
            }
        }
        Ok(resp) => last_err = Some(format!("Cloudflare meta HTTP {}", resp.status)),
        Err(e) => last_err = Some(e),
    }

    // 2. Cloudflare trace for WARP status + fallback IPv4/location
    if let Ok(resp) = http_fetch_simple("https://1.1.1.1/cdn-cgi/trace", "GET", None, timeout_ms.min(1_200)) {
        if (200..300).contains(&resp.status) {
            let text = String::from_utf8_lossy(&resp.body);
            let mut loc = None;
            let mut colo = None;
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("ip=") {
                    if ipv4.is_none() {
                        if let Ok(IpAddr::V4(ip)) = v.trim().parse::<IpAddr>() {
                            ipv4 = Some(ip.to_string());
                        }
                    }
                } else if let Some(v) = line.strip_prefix("loc=") {
                    loc = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("colo=") {
                    colo = Some(v.trim().to_string());
                } else if let Some(v) = line.strip_prefix("warp=") {
                    let w = v.trim().to_ascii_lowercase();
                    warp_status = match w.as_str() {
                        "plus" => Some("WARP+".to_string()),
                        "on" => Some("ON".to_string()),
                        "off" => Some("OFF".to_string()),
                        _ => None,
                    };
                }
            }
            if geo.is_none() && (loc.is_some() || colo.is_some()) {
                geo = Some(GeoIpInfo {
                    asn: None,
                    isp: None,
                    org: None,
                    country: loc,
                    city: None,
                    colo,
                    source: "1.1.1.1/cdn-cgi/trace".to_string(),
                });
            }
        }
    }

    // 3. Dedicated dual-stack IPv6 check (short timeout; gracefully None on IPv4-only networks)
    if ipv6.is_none() {
        if let Ok(resp) = http_fetch_simple(
            "https://api6.ipify.org?format=json",
            "GET",
            None,
            timeout_ms.min(1_500),
        ) {
            if (200..300).contains(&resp.status) {
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&resp.body) {
                    if let Some(ip_str) = val.get("ip").and_then(|v| v.as_str()) {
                        if let Ok(IpAddr::V6(v6)) = ip_str.trim().parse::<IpAddr>() {
                            ipv6 = Some(v6.to_string());
                        }
                    }
                }
            }
        }
    }

    // 4. Reverse DNS PTR lookup for public IP (pure-Rust RFC 1035 UDP PTR)
    let ptr = ipv4
        .as_deref()
        .or(ipv6.as_deref())
        .and_then(|ip| lookup_reverse_ptr(ip, sys_dns, Duration::from_millis(timeout_ms.min(1_000))));

    if ipv4.is_some() || ipv6.is_some() {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(CachedPublicNet {
                fetched_at: Instant::now(),
                ipv4: ipv4.clone(),
                ipv6: ipv6.clone(),
                geo: geo.clone(),
                ptr: ptr.clone(),
                warp_status: warp_status.clone(),
            });
        }
        return (
            DataProvenance::Live,
            ipv4,
            ipv6,
            geo,
            ptr,
            warp_status,
            None,
        );
    }

    // Fall back to prior cached observation if we have one (honestly tagged CACHED)
    if let Ok(guard) = cache.lock() {
        if let Some(ref c) = *guard {
            if c.ipv4.is_some() || c.ipv6.is_some() {
                return (
                    DataProvenance::Cached,
                    c.ipv4.clone(),
                    c.ipv6.clone(),
                    c.geo.clone(),
                    c.ptr.clone(),
                    c.warp_status.clone(),
                    Some(format!(
                        "Live public IP probe failed ({}); serving cached snapshot.",
                        last_err.unwrap_or_else(|| "network unreachable".into())
                    )),
                );
            }
        }
    }

    (
        DataProvenance::Unavailable,
        None,
        None,
        None,
        None,
        warp_status,
        Some(last_err.unwrap_or_else(|| "Public IP lookup unavailable (offline or blocked).".into())),
    )
}

// =========================================================================
// 2. DNS Intelligence, DoH/DoT Audit & Leak Check (RFC 1035/6891 Wire Client)
// =========================================================================

/// Validates an optional user-supplied custom DNS resolver IP (`v4` or `v6`, optional `:53`).
pub fn validate_custom_dns_ip(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Custom DNS IP is empty.".to_string());
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, ';' | '&' | '|' | '$' | '`' | '<' | '>' | '\\'))
    {
        return Err("Custom DNS IP contains invalid characters.".to_string());
    }
    let ip_str = if let Ok(sa) = trimmed.parse::<SocketAddr>() {
        if sa.port() != 53 {
            return Err("Custom DNS port must be 53 (standard UDP DNS).".to_string());
        }
        sa.ip().to_string()
    } else {
        trimmed.to_string()
    };
    let parsed: IpAddr = ip_str
        .parse()
        .map_err(|_| format!("Invalid IP address for custom DNS: '{trimmed}'"))?;
    if parsed.is_unspecified() || parsed.is_multicast() {
        return Err("Unspecified or multicast IP cannot be used as DNS resolver.".to_string());
    }
    if let IpAddr::V4(v4) = parsed {
        if v4.is_link_local() {
            return Err("Link-local IPv4 rejected for DNS resolver.".to_string());
        }
    }
    Ok(parsed.to_string())
}

/// Parses Windows `netsh dns show encryption` output for DoH server templates.
#[must_use]
pub fn parse_netsh_dns_encryption(raw: &str) -> (bool, Vec<String>) {
    let mut templates = Vec::new();
    let mut seen = BTreeSet::new();
    let mut enabled_hint = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("dns-over-https") && (lower.contains("auto") || lower.contains("yes") || lower.contains("enabled")) {
            enabled_hint = true;
        }
        for tok in trimmed.split_whitespace() {
            let clean = tok.trim_matches(|c| matches!(c, ',' | ';' | '"' | '\''));
            if clean.starts_with("https://") && clean.len() <= 200 && seen.insert(clean.to_string()) {
                templates.push(clean.to_string());
                enabled_hint = true;
            }
        }
    }
    (enabled_hint || !templates.is_empty(), templates)
}

fn detect_doh_dot_os(sys_dns: &[String]) -> (bool, String, Vec<String>, bool, String) {
    let mut doh_enabled = false;
    let mut doh_templates = Vec::new();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(out) = Command::new("netsh")
            .args(["dns", "show", "encryption"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if out.status.success() {
                let txt = String::from_utf8_lossy(&out.stdout);
                let (en, tpls) = parse_netsh_dns_encryption(&txt);
                doh_enabled = en;
                doh_templates = tpls;
            }
        }
    }

    let dot_enabled = sys_dns.iter().any(|d| {
        let l = d.to_ascii_lowercase();
        l.contains(":853") || l.starts_with("tls://")
    });
    let doh_status = if doh_enabled {
        if doh_templates.is_empty() {
            "ENABLED".to_string()
        } else {
            format!("ENABLED ({} templates)", doh_templates.len())
        }
    } else {
        "OFF / OS Default".to_string()
    };
    let dot_status = if dot_enabled {
        "DETECTED (:853)".to_string()
    } else {
        "OFF / Port 53".to_string()
    };
    (doh_enabled, doh_status, doh_templates, dot_enabled, dot_status)
}

/// Inspects system DNS configuration, DoH/DoT OS policy, hosts-file overrides,
/// benchmarks resolvers (incl. OpenDNS & custom DNS, DNSSEC AD, EDNS0, AAAA, uncached vs cached),
/// and checks VPN DNS leak risk.
#[must_use]
pub fn inspect_dns_and_benchmark(opts: &DnsBenchOptions) -> DnsIntelReport {
    let observed_at_ms = now_epoch_ms();
    let adapters = enumerate_local_adapters();

    let mut sys_dns = Vec::new();
    let mut seen_dns = BTreeSet::new();
    let mut suffixes = BTreeSet::new();
    let mut vpn_active = false;

    for a in &adapters {
        if a.status != "up" {
            continue;
        }
        if let Some(ref tag) = a.vpn_tag {
            if !tag.starts_with("WSL") {
                vpn_active = true;
            }
        }
        for d in &a.dns_servers {
            if seen_dns.insert(d.clone()) {
                sys_dns.push(d.clone());
            }
        }
        if let Some(ref sfx) = a.dns_suffix {
            if !sfx.trim().is_empty() {
                suffixes.insert(sfx.trim().to_string());
            }
        }
    }

    let (hosts_override_count, hosts_sample_domains) = inspect_hosts_file();
    let (doh_enabled, doh_status, doh_templates, dot_enabled, dot_status) =
        detect_doh_dot_os(&sys_dns);

    let domain = if opts.query_domain.trim().is_empty() {
        "example.com"
    } else {
        opts.query_domain.trim()
    };
    let trials = opts.trials.clamp(1, 8);
    let timeout = Duration::from_millis(opts.timeout_ms.clamp(200, 3_000));

    let mut resolvers = Vec::new();
    if opts.run_benchmark {
        // 1. System OS resolver
        resolvers.push(benchmark_system_resolver(domain, trials));

        // 2. Well-known public resolvers via direct RFC 1035/6891 UDP wire queries
        let mut udp_targets: Vec<(String, String)> = vec![
            ("Cloudflare".into(), "1.1.1.1".into()),
            ("Google".into(), "8.8.8.8".into()),
            ("Quad9".into(), "9.9.9.9".into()),
            ("AdGuard".into(), "94.140.14.14".into()),
            ("OpenDNS".into(), "208.67.222.222".into()),
        ];

        if let Some(ref raw_custom) = opts.custom_dns_ip {
            let trimmed = raw_custom.trim();
            if !trimmed.is_empty() {
                match validate_custom_dns_ip(trimmed) {
                    Ok(valid_ip) => {
                        if !udp_targets.iter().any(|(_, ip)| ip == &valid_ip) {
                            udp_targets.push((format!("Custom ({valid_ip})"), valid_ip));
                        }
                    }
                    Err(_) => {
                        resolvers.push(DnsResolverBench {
                            name: "Custom (Invalid)".to_string(),
                            server: trimmed.to_string(),
                            status: DataProvenance::Unavailable,
                            min_ms: None,
                            p50_ms: None,
                            p95_ms: None,
                            max_ms: None,
                            jitter_ms: None,
                            failure_rate_pct: 100.0,
                            samples_ms: Vec::new(),
                            resolved_ip: None,
                            hijack_detected: false,
                            uncached_ms: None,
                            cached_ms: None,
                            dnssec_ad: false,
                            edns0_supported: false,
                            aaaa_supported: false,
                            aaaa_answers: Vec::new(),
                        });
                    }
                }
            }
        }

        for (name, ip) in udp_targets {
            resolvers.push(benchmark_udp_resolver(&name, &ip, domain, trials, timeout));
        }
    }

    let fastest_resolver = resolvers
        .iter()
        .filter(|r| r.status == DataProvenance::Live && r.p50_ms.is_some())
        .min_by(|a, b| {
            a.p50_ms
                .unwrap_or(f64::MAX)
                .total_cmp(&b.p50_ms.unwrap_or(f64::MAX))
        })
        .map(|r| format!("{} ({:.1} ms)", r.name, r.p50_ms.unwrap_or(0.0)));

    // Observe DNS egress IP via system DNS server querying `whoami.akamai.net` A record
    let dns_egress_ip = if opts.run_benchmark {
        probe_dns_egress_ip(&sys_dns, timeout)
    } else {
        None
    };

    let (leak_status, leak_warning) = evaluate_dns_leak(
        vpn_active,
        opts.public_ipv4_hint.as_deref(),
        dns_egress_ip.as_deref(),
        &sys_dns,
    );
    let nxdomain_hijack = if opts.run_benchmark {
        let mut hijack_report = probe_nxdomain_hijack(&sys_dns, timeout);
        for res in &mut resolvers {
            if hijack_report.hijacking_resolvers.contains(&res.server) {
                res.hijack_detected = true;
            }
        }
        if !hijack_report.hijacking_resolvers.is_empty() {
            hijack_report.hijacked = true;
        }
        Some(hijack_report)
    } else {
        Some(NxdomainHijackReport {
            status: DataProvenance::Unavailable,
            probed_domain: String::new(),
            hijacked: false,
            hijack_ips: Vec::new(),
            resolvers_tested: Vec::new(),
            hijacking_resolvers: Vec::new(),
            detail: Some("NXDOMAIN hijack probe skipped when active benchmark is disabled.".to_string()),
        })
    };

    DnsIntelReport {
        system_dns_servers: sys_dns,
        search_suffixes: suffixes.into_iter().collect(),
        hosts_override_count,
        hosts_sample_domains,
        resolvers,
        fastest_resolver,
        dns_egress_ip,
        vpn_active,
        leak_status,
        leak_warning,
        observed_at_ms,
        nxdomain_hijack,
        doh_enabled,
        doh_status,
        doh_templates,
        dot_enabled,
        dot_status,
    }
}

fn evaluate_dns_leak(
    vpn_active: bool,
    public_ipv4: Option<&str>,
    dns_egress_ip: Option<&str>,
    sys_dns: &[String],
) -> (String, Option<String>) {
    if !vpn_active {
        return ("no_vpn".to_string(), None);
    }
    let Some(egress) = dns_egress_ip else {
        return (
            "unverified".to_string(),
            Some("VPN adapter is active, but DNS egress probe could not complete.".to_string()),
        );
    };
    let Some(pub_ip) = public_ipv4 else {
        return (
            "unverified".to_string(),
            Some(format!(
                "VPN active; DNS egress observed at {egress}, but public IPv4 is unavailable for comparison."
            )),
        );
    };
    let same_slash16 = match (pub_ip.parse::<Ipv4Addr>(), egress.parse::<Ipv4Addr>()) {
        (Ok(a), Ok(b)) => a.octets()[0] == b.octets()[0] && a.octets()[1] == b.octets()[1],
        _ => pub_ip == egress,
    };
    let has_lan_router_dns = sys_dns.iter().any(|d| {
        d.parse::<Ipv4Addr>()
            .ok()
            .is_some_and(|ip| ip.octets()[0] == 192 && ip.octets()[1] == 168)
    });
    if !same_slash16 && has_lan_router_dns {
        (
            "possible_dns_leak".to_string(),
            Some(format!(
                "VPN is active (public {pub_ip}), yet system DNS includes LAN router and DNS egress resolved via {egress}."
            )),
        )
    } else {
        ("none".to_string(), None)
    }
}

fn inspect_hosts_file() -> (usize, Vec<String>) {
    let hosts_path = if cfg!(windows) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        std::path::PathBuf::from(root)
            .join("System32")
            .join("drivers")
            .join("etc")
            .join("hosts")
    } else {
        std::path::PathBuf::from("/etc/hosts")
    };
    let Ok(raw) = std::fs::read_to_string(&hosts_path) else {
        return (0, Vec::new());
    };
    let mut count = 0usize;
    let mut domains = Vec::new();
    for line in raw.lines() {
        let clean = line.split('#').next().unwrap_or("").trim();
        if clean.is_empty() {
            continue;
        }
        let mut parts = clean.split_whitespace();
        let Some(_ip) = parts.next() else {
            continue;
        };
        for host in parts {
            count += 1;
            if domains.len() < 12 && !host.eq_ignore_ascii_case("localhost") {
                domains.push(host.to_string());
            }
        }
    }
    (count, domains)
}

fn benchmark_system_resolver(domain: &str, trials: usize) -> DnsResolverBench {
    let mut samples = Vec::with_capacity(trials);
    let mut resolved_ip = None;
    let mut aaaa_set = BTreeSet::new();
    for _ in 0..trials {
        let t0 = Instant::now();
        if let Ok(addrs) = (domain, 443u16).to_socket_addrs() {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let mut got_any = false;
            for addr in addrs {
                got_any = true;
                match addr.ip() {
                    IpAddr::V4(v4) => {
                        if resolved_ip.is_none() {
                            resolved_ip = Some(v4.to_string());
                        }
                    }
                    IpAddr::V6(v6) => {
                        aaaa_set.insert(v6.to_string());
                    }
                }
                if resolved_ip.is_none() {
                    resolved_ip = Some(addr.ip().to_string());
                }
            }
            if got_any {
                samples.push(round2(ms));
            }
        }
    }
    let stats = summarize_latency(&samples, trials);
    let uncached_ms = samples.first().copied();
    let cached_ms = if samples.len() >= 2 {
        percentile(&samples[1..], 50.0)
    } else {
        None
    };
    let aaaa_answers: Vec<String> = aaaa_set.into_iter().collect();
    DnsResolverBench {
        name: "System".to_string(),
        server: "os-resolver".to_string(),
        status: if samples.is_empty() {
            DataProvenance::Unavailable
        } else {
            DataProvenance::Live
        },
        min_ms: stats.min_ms,
        p50_ms: stats.p50_ms,
        p95_ms: stats.p95_ms,
        max_ms: stats.max_ms,
        jitter_ms: stats.jitter_ms,
        failure_rate_pct: stats.loss_pct,
        samples_ms: samples,
        resolved_ip,
        hijack_detected: false,
        uncached_ms,
        cached_ms,
        dnssec_ad: false,
        edns0_supported: false,
        aaaa_supported: !aaaa_answers.is_empty(),
        aaaa_answers,
    }
}

fn benchmark_udp_resolver(
    name: &str,
    server_ip: &str,
    domain: &str,
    trials: usize,
    timeout: Duration,
) -> DnsResolverBench {
    let mut samples = Vec::with_capacity(trials);
    let mut resolved_ip = None;
    let mut dnssec_ad = false;
    let mut edns0_supported = false;

    for idx in 0..trials {
        let tx_id = 0x4A00u16.wrapping_add((idx as u16).wrapping_mul(37));
        let t0 = Instant::now();
        // Query with EDNS0 + DO bit on trial 0 to observe DNSSEC AD & EDNS0 OPT support directly
        if let Ok(reply) = udp_dns_query_ex(server_ip, domain, 1, tx_id, idx == 0, timeout) {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if reply.rcode == 0 && !reply.answers_v4.is_empty() {
                if resolved_ip.is_none() {
                    resolved_ip = reply.answers_v4.first().cloned();
                }
                if idx == 0 {
                    dnssec_ad = reply.ad_flag;
                    edns0_supported = reply.edns0_present;
                }
                samples.push(round2(ms));
            }
        }
    }

    let mut aaaa_answers = Vec::new();
    if !samples.is_empty() {
        let tx_v6 = 0x4F00u16.wrapping_add((server_ip.len() as u16).wrapping_mul(13));
        if let Ok(v6_reply) = udp_dns_query_ex(server_ip, domain, 28, tx_v6, true, timeout.min(Duration::from_millis(800))) {
            if v6_reply.edns0_present {
                edns0_supported = true;
            }
            if v6_reply.ad_flag {
                dnssec_ad = true;
            }
            aaaa_answers = v6_reply.answers_v6;
        }
    }

    let stats = summarize_latency(&samples, trials);
    let uncached_ms = samples.first().copied();
    let cached_ms = if samples.len() >= 2 {
        percentile(&samples[1..], 50.0)
    } else {
        None
    };

    DnsResolverBench {
        name: name.to_string(),
        server: server_ip.to_string(),
        status: if samples.is_empty() {
            DataProvenance::Unavailable
        } else {
            DataProvenance::Live
        },
        min_ms: stats.min_ms,
        p50_ms: stats.p50_ms,
        p95_ms: stats.p95_ms,
        max_ms: stats.max_ms,
        jitter_ms: stats.jitter_ms,
        failure_rate_pct: stats.loss_pct,
        samples_ms: samples,
        resolved_ip,
        hijack_detected: false,
        uncached_ms,
        cached_ms,
        dnssec_ad,
        edns0_supported,
        aaaa_supported: !aaaa_answers.is_empty(),
        aaaa_answers,
    }
}

fn probe_dns_egress_ip(sys_dns: &[String], timeout: Duration) -> Option<String> {
    // Query `whoami.akamai.net` A record against first IPv4 system DNS (or OS resolver fallback).
    if let Some(first_v4) = sys_dns
        .iter()
        .find(|d| d.parse::<Ipv4Addr>().is_ok())
    {
        if let Ok(ip) = udp_dns_query_a(first_v4, "whoami.akamai.net", 0x5B21, timeout) {
            return Some(ip);
        }
    }
    ("whoami.akamai.net", 53u16)
        .to_socket_addrs()
        .ok()?
        .find(|a| a.is_ipv4())
        .map(|a| a.ip().to_string())
}

fn lookup_reverse_ptr(ip_str: &str, sys_dns: &[String], timeout: Duration) -> Option<String> {
    let ip: IpAddr = ip_str.trim().parse().ok()?;
    let ptr_name = build_ptr_qname(ip);
    let mut servers: Vec<&str> = sys_dns
        .iter()
        .filter(|s| s.parse::<IpAddr>().is_ok())
        .map(String::as_str)
        .take(2)
        .collect();
    for fallback in ["1.1.1.1", "8.8.8.8"] {
        if !servers.contains(&fallback) {
            servers.push(fallback);
        }
    }
    for (idx, srv) in servers.into_iter().enumerate() {
        let tx = 0x7A00u16.wrapping_add(idx as u16);
        if let Ok(reply) = udp_dns_query_ex(srv, &ptr_name, 12, tx, false, timeout) {
            if let Some(first) = reply.ptr_names.into_iter().find(|n| !n.is_empty()) {
                return Some(first);
            }
        }
    }
    None
}

/// Formats an IPv4 or IPv6 address into its canonical reverse-DNS PTR domain name.
#[must_use]
pub fn build_ptr_qname(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        IpAddr::V6(v6) => {
            let mut parts = Vec::with_capacity(34);
            for b in v6.octets().iter().rev() {
                parts.push(format!("{:x}", b & 0x0f));
                parts.push(format!("{:x}", (b >> 4) & 0x0f));
            }
            parts.push("ip6".to_string());
            parts.push("arpa".to_string());
            parts.join(".")
        }
    }
}

/// Builds an RFC 1035 / RFC 6891 DNS query packet for `qtype` (`1`=A, `28`=AAAA, `12`=PTR)
/// with optional EDNS0 OPT RR + `DO=1` (DNSSEC OK).
#[must_use]
pub fn build_dns_query_ex(domain: &str, qtype: u16, tx_id: u16, edns0_do: bool) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(80);
    pkt.extend_from_slice(&tx_id.to_be_bytes());
    pkt.extend_from_slice(&0x0100u16.to_be_bytes()); // RD=1 standard query
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT=1
    pkt.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT=0
    pkt.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT=0
    pkt.extend_from_slice(&(if edns0_do { 1u16 } else { 0u16 }).to_be_bytes()); // ARCOUNT
    for label in domain.trim_matches('.').split('.') {
        if label.is_empty() {
            continue;
        }
        let bytes = label.as_bytes();
        let len = bytes.len().min(63);
        pkt.push(len as u8);
        pkt.extend_from_slice(&bytes[..len]);
    }
    pkt.push(0); // root terminator
    pkt.extend_from_slice(&qtype.to_be_bytes());
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN (1)

    if edns0_do {
        // RFC 6891 OPT RR: root(0), TYPE=41, UDP payload=1232, extRCODE+ver=0, DO=0x8000, RDLEN=0
        pkt.push(0);
        pkt.extend_from_slice(&41u16.to_be_bytes());
        pkt.extend_from_slice(&1232u16.to_be_bytes());
        pkt.extend_from_slice(&0u16.to_be_bytes());
        pkt.extend_from_slice(&0x8000u16.to_be_bytes());
        pkt.extend_from_slice(&0u16.to_be_bytes());
    }
    pkt
}

/// Builds a minimal RFC 1035 DNS A-record query packet.
#[must_use]
pub fn build_dns_a_query(domain: &str, tx_id: u16) -> Vec<u8> {
    build_dns_query_ex(domain, 1, tx_id, false)
}

/// Parses an RFC 1035 / RFC 6891 wire DNS reply extracting `RCODE`, `AD` flag, `EDNS0 OPT`,
/// and `A`, `AAAA`, and `PTR` resource records.
pub fn parse_dns_wire_reply(buf: &[u8], expected_tx_id: u16) -> Result<DnsWireReply, String> {
    if buf.len() < 12 {
        return Err(format!("truncated DNS packet ({} bytes)", buf.len()));
    }
    let tx_id = u16::from_be_bytes([buf[0], buf[1]]);
    if tx_id != expected_tx_id {
        return Err("DNS transaction ID mismatch".to_string());
    }
    if (buf[2] & 0x80) == 0 {
        return Err("DNS packet is not a response".to_string());
    }
    let rcode = buf[3] & 0x0F;
    let ad_flag = (buf[3] & 0x20) != 0;
    let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let nscount = u16::from_be_bytes([buf[8], buf[9]]) as usize;
    let arcount = u16::from_be_bytes([buf[10], buf[11]]) as usize;

    let mut pos = 12usize;
    for _ in 0..qdcount {
        pos = skip_dns_name(buf, pos).ok_or_else(|| "malformed DNS question".to_string())?;
        pos = pos
            .checked_add(4)
            .filter(|&p| p <= buf.len())
            .ok_or_else(|| "truncated DNS question".to_string())?;
    }

    let mut answers_v4 = Vec::new();
    let mut answers_v6 = Vec::new();
    let mut ptr_names = Vec::new();

    for _ in 0..ancount {
        pos = skip_dns_name(buf, pos).ok_or_else(|| "malformed DNS answer".to_string())?;
        if pos + 10 > buf.len() {
            return Err("truncated DNS answer RR".to_string());
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlen > buf.len() {
            return Err("truncated DNS answer rdata".to_string());
        }
        if rtype == 1 && rdlen == 4 {
            answers_v4.push(Ipv4Addr::new(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]).to_string());
        } else if rtype == 28 && rdlen == 16 {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[pos..pos + 16]);
            answers_v6.push(Ipv6Addr::from(octets).to_string());
        } else if rtype == 12 {
            if let Some((name, _)) = decode_dns_name(buf, pos) {
                if !name.is_empty() {
                    ptr_names.push(name);
                }
            }
        }
        pos += rdlen;
    }

    // Skip authority section cleanly before inspecting Additional section for EDNS0 OPT (type 41)
    let mut edns0_present = false;
    for _ in 0..nscount {
        let Some(next) = skip_dns_name(buf, pos) else {
            return Ok(DnsWireReply {
                rcode,
                ad_flag,
                edns0_present,
                answers_v4,
                answers_v6,
                ptr_names,
            });
        };
        pos = next;
        if pos + 10 > buf.len() {
            return Ok(DnsWireReply {
                rcode,
                ad_flag,
                edns0_present,
                answers_v4,
                answers_v6,
                ptr_names,
            });
        }
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlen > buf.len() {
            break;
        }
        pos += rdlen;
    }

    for _ in 0..arcount {
        let Some(next) = skip_dns_name(buf, pos) else {
            break;
        };
        pos = next;
        if pos + 10 > buf.len() {
            break;
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        if rtype == 41 {
            edns0_present = true;
        }
        pos += 10;
        if pos + rdlen > buf.len() {
            break;
        }
        pos += rdlen;
    }

    Ok(DnsWireReply {
        rcode,
        ad_flag,
        edns0_present,
        answers_v4,
        answers_v6,
        ptr_names,
    })
}

/// Parses the first IPv4 A-record from an RFC 1035 DNS response matching `expected_tx_id`.
#[must_use]
pub fn parse_dns_a_response(buf: &[u8], expected_tx_id: u16) -> Option<String> {
    let reply = parse_dns_wire_reply(buf, expected_tx_id).ok()?;
    if reply.rcode != 0 {
        return None;
    }
    reply.answers_v4.into_iter().next()
}

fn decode_dns_name(buf: &[u8], start: usize) -> Option<(String, usize)> {
    let mut pos = start;
    let mut end_pos = None;
    let mut labels = Vec::new();
    let mut jumps = 0usize;
    while pos < buf.len() {
        let len = buf[pos];
        if len == 0 {
            if end_pos.is_none() {
                end_pos = Some(pos + 1);
            }
            return Some((labels.join("."), end_pos.unwrap_or(pos + 1)));
        }
        if (len & 0xC0) == 0xC0 {
            if pos + 1 >= buf.len() {
                return None;
            }
            let ptr = (usize::from(len & 0x3F) << 8) | usize::from(buf[pos + 1]);
            if ptr >= buf.len() {
                return None;
            }
            if end_pos.is_none() {
                end_pos = Some(pos + 2);
            }
            pos = ptr;
            jumps += 1;
            if jumps > 32 {
                return None;
            }
            continue;
        }
        let l = usize::from(len);
        let next = pos.checked_add(1 + l)?;
        if next > buf.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&buf[pos + 1..next]).to_string());
        pos = next;
        jumps += 1;
        if jumps > 64 {
            return None;
        }
    }
    None
}

fn skip_dns_name(buf: &[u8], mut pos: usize) -> Option<usize> {
    let mut jumps = 0usize;
    while pos < buf.len() {
        let len = buf[pos];
        if len == 0 {
            return Some(pos + 1);
        }
        if (len & 0xC0) == 0xC0 {
            return pos.checked_add(2).filter(|&p| p <= buf.len());
        }
        pos = pos.checked_add(1 + usize::from(len))?;
        jumps += 1;
        if jumps > 64 {
            return None;
        }
    }
    None
}

fn udp_dns_query_ex(
    server_ip: &str,
    domain: &str,
    qtype: u16,
    tx_id: u16,
    edns0_do: bool,
    timeout: Duration,
) -> Result<DnsWireReply, String> {
    let server: IpAddr = server_ip
        .parse()
        .map_err(|_| format!("invalid DNS IP '{server_ip}'"))?;
    let bind_addr: SocketAddr = if server.is_ipv6() {
        SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0))
    } else {
        SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))
    };
    let sock = UdpSocket::bind(bind_addr).map_err(|e| e.to_string())?;
    sock.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    sock.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let query = build_dns_query_ex(domain, qtype, tx_id, edns0_do);
    sock.send_to(&query, SocketAddr::new(server, 53))
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 1500];
    let (n, _) = sock.recv_from(&mut buf).map_err(|e| e.to_string())?;
    parse_dns_wire_reply(&buf[..n], tx_id)
}

fn udp_dns_query_a(
    server_ip: &str,
    domain: &str,
    tx_id: u16,
    timeout: Duration,
) -> Result<String, String> {
    let reply = udp_dns_query_ex(server_ip, domain, 1, tx_id, false, timeout)?;
    if reply.rcode != 0 {
        return Err(format!("DNS RCODE {}", reply.rcode));
    }
    reply
        .answers_v4
        .into_iter()
        .next()
        .ok_or_else(|| "no A record in DNS response".to_string())
}

const STUN_MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
const STUN_MSG_BINDING_REQUEST: u16 = 0x0001;
const STUN_MSG_BINDING_RESPONSE: u16 = 0x0101;
const STUN_ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Encodes a 20-byte RFC 5389 STUN Binding Request with magic cookie `0x2112A442`.
#[must_use]
pub fn encode_stun_binding_request(tx_id: [u8; 12]) -> [u8; 20] {
    let mut pkt = [0u8; 20];
    pkt[0..2].copy_from_slice(&STUN_MSG_BINDING_REQUEST.to_be_bytes());
    pkt[2..4].copy_from_slice(&0u16.to_be_bytes());
    pkt[4..8].copy_from_slice(&STUN_MAGIC_COOKIE);
    pkt[8..20].copy_from_slice(&tx_id);
    pkt
}

/// Decodes an RFC 5389 STUN Binding Success Response, extracting `XOR-MAPPED-ADDRESS`
/// (preferred) or `MAPPED-ADDRESS` (fallback) matching `expected_tx_id`.
pub fn decode_stun_response(
    pkt: &[u8],
    expected_tx_id: &[u8; 12],
) -> Result<StunMappedAddress, String> {
    if pkt.len() < 20 {
        return Err(format!("truncated STUN packet ({} bytes)", pkt.len()));
    }
    let msg_type = u16::from_be_bytes([pkt[0], pkt[1]]);
    if msg_type != STUN_MSG_BINDING_RESPONSE {
        return Err(format!("unexpected STUN message type 0x{msg_type:04X}"));
    }
    if pkt[4..8] != STUN_MAGIC_COOKIE {
        return Err("invalid STUN magic cookie".to_string());
    }
    if &pkt[8..20] != expected_tx_id {
        return Err("STUN transaction ID mismatch".to_string());
    }
    let msg_len = u16::from_be_bytes([pkt[2], pkt[3]]) as usize;
    let end = 20usize.saturating_add(msg_len).min(pkt.len());
    let mut pos = 20usize;
    let mut fallback: Option<StunMappedAddress> = None;

    while pos + 4 <= end {
        let attr_type = u16::from_be_bytes([pkt[pos], pkt[pos + 1]]);
        let attr_len = u16::from_be_bytes([pkt[pos + 2], pkt[pos + 3]]) as usize;
        let val_start = pos + 4;
        let Some(val_end) = val_start.checked_add(attr_len) else {
            break;
        };
        if val_end > end {
            break;
        }
        let val = &pkt[val_start..val_end];
        if attr_type == STUN_ATTR_XOR_MAPPED_ADDRESS {
            if let Some(addr) = parse_stun_mapped_attr(val, expected_tx_id, true) {
                return Ok(StunMappedAddress {
                    ip: addr.0,
                    port: addr.1,
                    attribute: "XOR-MAPPED-ADDRESS".to_string(),
                });
            }
        } else if attr_type == STUN_ATTR_MAPPED_ADDRESS && fallback.is_none() {
            if let Some(addr) = parse_stun_mapped_attr(val, expected_tx_id, false) {
                fallback = Some(StunMappedAddress {
                    ip: addr.0,
                    port: addr.1,
                    attribute: "MAPPED-ADDRESS".to_string(),
                });
            }
        }
        let padded = (attr_len + 3) & !3;
        pos = val_start.saturating_add(padded).min(end);
        if padded == 0 && attr_len == 0 {
            pos = val_start;
        }
    }

    fallback.ok_or_else(|| "STUN response missing XOR-MAPPED-ADDRESS / MAPPED-ADDRESS".to_string())
}

fn parse_stun_mapped_attr(val: &[u8], tx_id: &[u8; 12], xor: bool) -> Option<(String, u16)> {
    if val.len() < 8 {
        return None;
    }
    let family = val[1];
    let raw_port = u16::from_be_bytes([val[2], val[3]]);
    let port = if xor { raw_port ^ 0x2112 } else { raw_port };

    match family {
        0x01 if val.len() >= 8 => {
            let mut octets = [val[4], val[5], val[6], val[7]];
            if xor {
                for i in 0..4 {
                    octets[i] ^= STUN_MAGIC_COOKIE[i];
                }
            }
            Some((Ipv4Addr::from(octets).to_string(), port))
        }
        0x02 if val.len() >= 20 => {
            let mut mask = [0u8; 16];
            mask[..4].copy_from_slice(&STUN_MAGIC_COOKIE);
            mask[4..16].copy_from_slice(tx_id);
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&val[4..20]);
            if xor {
                for i in 0..16 {
                    octets[i] ^= mask[i];
                }
            }
            Some((Ipv6Addr::from(octets).to_string(), port))
        }
        _ => None,
    }
}

fn make_stun_tx_id(salt: u8) -> [u8; 12] {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut tx = [0u8; 12];
    tx[0..8].copy_from_slice(&seq.wrapping_add(nanos as u64).to_be_bytes());
    tx[8..12].copy_from_slice(&(std::process::id() ^ u32::from(salt)).to_be_bytes());
    tx
}

fn probe_stun_nat(local_ipv4s: &[Ipv4Addr], timeout: Duration) -> StunProbeReport {
    let servers = ["stun.cloudflare.com:3478", "stun.l.google.com:19302"];
    let sock = match UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))) {
        Ok(s) => s,
        Err(e) => {
            return StunProbeReport {
                status: DataProvenance::Unavailable,
                server: None,
                mapped_ip: None,
                mapped_port: None,
                attribute: None,
                nat_mapping_behavior: "unavailable".to_string(),
                endpoints_probed: Vec::new(),
                rtt_ms: None,
                error: Some(format!("UDP socket bind failed: {e}")),
            };
        }
    };
    let per_try = timeout.clamp(Duration::from_millis(250), Duration::from_millis(900));
    let _ = sock.set_read_timeout(Some(per_try));
    let _ = sock.set_write_timeout(Some(per_try));

    let mut probed = Vec::new();
    let mut results: Vec<(&str, StunMappedAddress, u64)> = Vec::new();
    let mut last_err: Option<String> = None;

    for (idx, srv) in servers.iter().enumerate() {
        probed.push((*srv).to_string());
        let Ok(mut addrs) = srv.to_socket_addrs() else {
            last_err = Some(format!("DNS resolve failed for {srv}"));
            continue;
        };
        let Some(target) = addrs.find(SocketAddr::is_ipv4) else {
            last_err = Some(format!("no IPv4 address for {srv}"));
            continue;
        };
        let tx_id = make_stun_tx_id(idx as u8);
        let req = encode_stun_binding_request(tx_id);
        let t0 = Instant::now();
        if let Err(e) = sock.send_to(&req, target) {
            last_err = Some(format!("STUN send to {srv} failed: {e}"));
            continue;
        }
        let mut buf = [0u8; 512];
        match sock.recv_from(&mut buf) {
            Ok((n, _)) => match decode_stun_response(&buf[..n], &tx_id) {
                Ok(mapped) => {
                    let rtt = t0.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    results.push((*srv, mapped, rtt));
                }
                Err(e) => last_err = Some(format!("STUN decode from {srv} failed: {e}")),
            },
            Err(e) => last_err = Some(format!("STUN recv from {srv} timed out/failed: {e}")),
        }
    }

    if let Some((first_srv, first_mapped, rtt)) = results.first() {
        let local_matches = first_mapped
            .ip
            .parse::<Ipv4Addr>()
            .ok()
            .is_some_and(|ip| local_ipv4s.contains(&ip));
        let nat_mapping_behavior = if local_matches {
            "direct_no_nat".to_string()
        } else if results.len() >= 2
            && (results[0].1.port != results[1].1.port || results[0].1.ip != results[1].1.ip)
        {
            "symmetric_nat".to_string()
        } else {
            "endpoint_independent_cone_nat".to_string()
        };
        StunProbeReport {
            status: DataProvenance::Live,
            server: Some((*first_srv).to_string()),
            mapped_ip: Some(first_mapped.ip.clone()),
            mapped_port: Some(first_mapped.port),
            attribute: Some(first_mapped.attribute.clone()),
            nat_mapping_behavior,
            endpoints_probed: probed,
            rtt_ms: Some(*rtt),
            error: None,
        }
    } else {
        StunProbeReport {
            status: DataProvenance::Unavailable,
            server: None,
            mapped_ip: None,
            mapped_port: None,
            attribute: None,
            nat_mapping_behavior: "unavailable".to_string(),
            endpoints_probed: probed,
            rtt_ms: None,
            error: last_err,
        }
    }
}

/// Parses an RFC 1035 response for an NXDOMAIN probe, extracting `RCODE` and all IPv4 `A` answers.
pub fn parse_dns_nxdomain_reply(
    buf: &[u8],
    expected_tx_id: u16,
) -> Result<DnsNxdomainParseResult, String> {
    if buf.len() < 12 {
        return Err(format!("truncated DNS packet ({} bytes)", buf.len()));
    }
    let tx_id = u16::from_be_bytes([buf[0], buf[1]]);
    if tx_id != expected_tx_id {
        return Err("DNS transaction ID mismatch".to_string());
    }
    if (buf[2] & 0x80) == 0 {
        return Err("DNS packet is not a response".to_string());
    }
    let rcode = buf[3] & 0x0F;
    let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut pos = 12usize;
    for _ in 0..qdcount {
        pos = skip_dns_name(buf, pos).ok_or_else(|| "malformed DNS question".to_string())?;
        pos = pos
            .checked_add(4)
            .filter(|&p| p <= buf.len())
            .ok_or_else(|| "truncated DNS question".to_string())?;
    }

    let mut answers_v4 = Vec::new();
    for _ in 0..ancount {
        pos = skip_dns_name(buf, pos).ok_or_else(|| "malformed DNS answer".to_string())?;
        if pos + 10 > buf.len() {
            return Err("truncated DNS answer RR".to_string());
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlen > buf.len() {
            return Err("truncated DNS answer rdata".to_string());
        }
        if rtype == 1 && rdlen == 4 {
            answers_v4.push(Ipv4Addr::new(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]).to_string());
        }
        pos += rdlen;
    }

    let hijacked = rcode == 0 && !answers_v4.is_empty();
    Ok(DnsNxdomainParseResult {
        rcode,
        answers_v4,
        hijacked,
    })
}

fn probe_nxdomain_against_server(
    server_ip: &str,
    domain: &str,
    tx_id: u16,
    timeout: Duration,
) -> Result<DnsNxdomainParseResult, String> {
    let server: IpAddr = server_ip
        .parse()
        .map_err(|_| format!("invalid DNS IP '{server_ip}'"))?;
    let bind_addr: SocketAddr = if server.is_ipv6() {
        SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0))
    } else {
        SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))
    };
    let sock = UdpSocket::bind(bind_addr).map_err(|e| e.to_string())?;
    let bounded = timeout.clamp(Duration::from_millis(200), Duration::from_millis(1_000));
    sock.set_read_timeout(Some(bounded)).map_err(|e| e.to_string())?;
    sock.set_write_timeout(Some(bounded)).map_err(|e| e.to_string())?;
    let query = build_dns_a_query(domain, tx_id);
    sock.send_to(&query, SocketAddr::new(server, 53))
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 512];
    let (n, _) = sock.recv_from(&mut buf).map_err(|e| e.to_string())?;
    parse_dns_nxdomain_reply(&buf[..n], tx_id)
}

fn probe_nxdomain_hijack(sys_dns: &[String], timeout: Duration) -> NxdomainHijackReport {
    let probe_domain = format!("nxprobe-{}-omnia.nonexistent.invalid", now_epoch_ms());
    let mut candidates: Vec<String> = sys_dns
        .iter()
        .filter(|s| s.parse::<IpAddr>().is_ok())
        .take(2)
        .cloned()
        .collect();
    for pub_dns in ["1.1.1.1", "8.8.8.8"] {
        if !candidates.iter().any(|c| c == pub_dns) {
            candidates.push(pub_dns.to_string());
        }
    }

    let mut tested = Vec::new();
    let mut hijacking_resolvers = Vec::new();
    let mut hijack_ips = BTreeSet::new();
    let mut responded = 0usize;

    for (idx, srv) in candidates.iter().enumerate() {
        let tx_id = 0x6C00u16.wrapping_add((idx as u16).wrapping_mul(41));
        if let Ok(parsed) = probe_nxdomain_against_server(srv, &probe_domain, tx_id, timeout) {
            responded += 1;
            tested.push(srv.clone());
            if parsed.hijacked {
                hijacking_resolvers.push(srv.clone());
                for ip in parsed.answers_v4 {
                    hijack_ips.insert(ip);
                }
            }
        }
    }

    let hijacked = !hijacking_resolvers.is_empty();
    let hijack_ips_vec: Vec<String> = hijack_ips.into_iter().collect();
    let detail = if responded == 0 {
        Some("NXDOMAIN probe received no UDP DNS replies (offline or filtered).".to_string())
    } else if hijacked {
        Some(format!(
            "Resolver(s) {} synthesized A record(s) [{}] for non-existent RFC 2606 domain.",
            hijacking_resolvers.join(", "),
            hijack_ips_vec.join(", ")
        ))
    } else {
        Some("All responding resolvers cleanly returned NXDOMAIN (no DNS hijacking).".to_string())
    };

    NxdomainHijackReport {
        status: if responded == 0 {
            DataProvenance::Unavailable
        } else {
            DataProvenance::Live
        },
        probed_domain: probe_domain,
        hijacked,
        hijack_ips: hijack_ips_vec,
        resolvers_tested: tested,
        hijacking_resolvers,
        detail,
    }
}

// =========================================================================
// 3. Proxy, PAC, Loopback PID Listeners, TLS Chain Inspector & 9-Endpoint Waterfall
// =========================================================================

fn parse_csv_first_two(line: &str) -> Option<(String, u32)> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in line.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut cur));
                if fields.len() >= 2 {
                    break;
                }
            }
            _ => cur.push(ch),
        }
    }
    if fields.len() < 2 {
        fields.push(cur);
    }
    let name = fields.first()?.trim().to_string();
    let pid = fields.get(1)?.trim().parse::<u32>().ok()?;
    if name.is_empty() {
        None
    } else {
        Some((name, pid))
    }
}

/// Parses `netstat -ano -p TCP` listening sockets and `tasklist /FO CSV /NH` PID->process table.
#[must_use]
pub fn parse_netstat_tcp_listeners(
    netstat_out: &str,
    tasklist_csv: &str,
) -> HashMap<u16, (u32, String)> {
    let mut pid_names: HashMap<u32, String> = HashMap::new();
    for line in tasklist_csv.lines() {
        if let Some((name, pid)) = parse_csv_first_two(line) {
            pid_names.insert(pid, name);
        }
    }

    let mut listeners: HashMap<u16, (u32, String)> = HashMap::new();
    for line in netstat_out.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 || !parts[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        let state_idx = parts
            .iter()
            .position(|p| p.eq_ignore_ascii_case("LISTENING"));
        let Some(s_idx) = state_idx else {
            continue;
        };
        let Some(pid) = parts.get(s_idx + 1).and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let local_ep = parts[1];
        let Some((_, port_str)) = local_ep.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };
        let is_local_bind = local_ep.starts_with("127.0.0.1:")
            || local_ep.starts_with("0.0.0.0:")
            || local_ep.starts_with("[::1]:")
            || local_ep.starts_with("[::]:");
        if !is_local_bind {
            continue;
        }
        let proc_name = pid_names
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| format!("pid:{pid}"));
        listeners.entry(port).or_insert((pid, proc_name));
    }
    listeners
}

/// Maps process name and fallback label to `(suspected_tool, risk_level)`.
#[must_use]
pub fn classify_proxy_process(proc_name: Option<&str>, fallback_label: &str) -> (String, String) {
    let p = proc_name.unwrap_or("").to_ascii_lowercase();
    let f = fallback_label.to_ascii_lowercase();
    let hay = format!("{p} {f}");
    if hay.contains("fiddler") {
        ("Fiddler Debugging Proxy".to_string(), "high".to_string())
    } else if hay.contains("charles") {
        ("Charles Debugging Proxy".to_string(), "high".to_string())
    } else if hay.contains("mitmproxy") || hay.contains("mitmdump") || hay.contains("mitmweb") {
        ("mitmproxy Interceptor".to_string(), "high".to_string())
    } else if hay.contains("burp") {
        ("Burp Suite Proxy".to_string(), "high".to_string())
    } else if hay.contains("clash") || hay.contains("mihomo") {
        ("Clash / Mihomo".to_string(), "low".to_string())
    } else if hay.contains("v2ray") || hay.contains("xray") {
        ("v2rayN / Xray".to_string(), "low".to_string())
    } else if hay.contains("sing-box") || hay.contains("nekoray") || hay.contains("nekobox") {
        ("Sing-box / Nekoray".to_string(), "low".to_string())
    } else if hay.contains("adguard") {
        ("AdGuard Filter".to_string(), "low".to_string())
    } else if hay.contains("privoxy") || hay.contains("tor") {
        ("Tor / Privoxy".to_string(), "medium".to_string())
    } else if hay.contains("proxy") {
        (fallback_label.to_string(), "medium".to_string())
    } else {
        (fallback_label.to_string(), "low".to_string())
    }
}

fn collect_windows_tcp_listeners() -> HashMap<u16, (u32, String)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let (ns_out, tl_out) = std::thread::scope(|s| {
            let h1 = s.spawn(|| {
                Command::new("netstat")
                    .args(["-ano", "-p", "TCP"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                    .unwrap_or_default()
            });
            let h2 = s.spawn(|| {
                Command::new("tasklist")
                    .args(["/FO", "CSV", "/NH"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                    .unwrap_or_default()
            });
            (h1.join().unwrap_or_default(), h2.join().unwrap_or_default())
        });
        parse_netstat_tcp_listeners(&ns_out, &tl_out)
    }
    #[cfg(not(windows))]
    {
        HashMap::new()
    }
}

/// Inspects environment proxies, WinINET/WinHTTP/PAC config (with reachability & bytes),
/// loopback PID proxy listeners, direct-vs-proxied TTFB delta, and 9-endpoint categorized
/// `DNS -> TCP -> TLS -> TTFB` waterfalls + TLS chain inspection (concurrently, rate-bounded).
#[must_use]
pub fn inspect_proxy_tls_and_endpoints(
    targets: &[EndpointProbeTarget],
    force: bool,
) -> ProxyTlsReport {
    let cache = WATERFALL_CACHE.get_or_init(|| Mutex::new(None));
    if !force && targets.is_empty() {
        if let Ok(guard) = cache.lock() {
            if let Some((at, ref rep)) = *guard {
                if at.elapsed() < Duration::from_secs(15) {
                    return rep.clone();
                }
            }
        }
    }

    let observed_at_ms = now_epoch_ms();
    let env_proxies = collect_env_proxies();
    let system_proxy = query_windows_system_proxy();
    let local_proxy_ports = probe_local_proxy_ports(&env_proxies, &system_proxy);

    let effective_targets = if targets.is_empty() {
        default_upstream_targets()
    } else {
        targets.to_vec()
    };

    // Probe all targets concurrently via bounded std::thread::scope (<= ~3s total)
    let endpoints: Vec<EndpointWaterfall> = std::thread::scope(|s| {
        let handles: Vec<_> = effective_targets
            .into_iter()
            .map(|target| {
                s.spawn(move || {
                    if is_forbidden_probe_url(&target.url) {
                        EndpointWaterfall {
                            id: target.id,
                            label: target.label,
                            url: target.url,
                            host: String::new(),
                            provenance: DataProvenance::Unavailable,
                            dns_ms: None,
                            tcp_ms: None,
                            tls_ms: None,
                            ttfb_ms: None,
                            total_ms: None,
                            http_status: None,
                            tls_version: None,
                            cipher_strength_bits: None,
                            cert_subject: None,
                            cert_issuer: None,
                            cert_not_before: None,
                            cert_not_after: None,
                            cert_days_remaining: None,
                            mitm_ca_suspected: false,
                            mitm_ca_reason: None,
                            error: Some(
                                "Target blocked by policy (agy/OAuth/IMDS probes forbidden)."
                                    .to_string(),
                            ),
                            observed_at_ms,
                            category: Some("Blocked".to_string()),
                            resolved_ip: None,
                            http_version: None,
                            alpn: None,
                            chain_depth: None,
                            root_issuer: None,
                            leaf_sha256: None,
                        }
                    } else {
                        probe_endpoint_waterfall(&target, 3_000)
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .collect()
    });

    let mut mitm_warning = None;
    for wf in &endpoints {
        if wf.mitm_ca_suspected && mitm_warning.is_none() {
            mitm_warning = Some(format!(
                "Local TLS inspection CA detected on {}: {}",
                wf.host,
                wf.mitm_ca_reason
                    .as_deref()
                    .or(wf.cert_issuer.as_deref())
                    .unwrap_or("non-public CA")
            ));
        }
    }

    // PAC reachability & byte size probe
    let (pac_reachable, pac_bytes) = probe_pac_url_status(system_proxy.pac_url.as_deref());

    // Direct vs Proxied TTFB overhead measurement when proxy config or local proxy is active
    let proxy_configured = env_proxies
        .iter()
        .any(|e| !e.name.eq_ignore_ascii_case("no_proxy"))
        || system_proxy.ie_proxy_server.is_some()
        || system_proxy.pac_url.is_some()
        || system_proxy.winhttp_proxy.is_some()
        || !local_proxy_ports.is_empty();
    let proxy_overhead_ms = if proxy_configured {
        measure_proxy_overhead_ms(system_proxy.ie_proxy_server.as_deref())
    } else {
        None
    };

    let report = ProxyTlsReport {
        env_proxies,
        system_proxy,
        local_proxy_ports,
        endpoints,
        mitm_warning,
        observed_at_ms,
        pac_reachable,
        pac_bytes,
        proxy_overhead_ms,
    };

    if targets.is_empty() {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some((Instant::now(), report.clone()));
        }
    }

    report
}

fn probe_pac_url_status(pac_url_masked: Option<&str>) -> (Option<bool>, Option<u64>) {
    let Some(raw) = pac_url_masked else {
        return (None, None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_forbidden_probe_url(trimmed) {
        return (None, None);
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return (Some(false), Some(0));
    }
    match http_fetch_simple(trimmed, "GET", None, 2_000) {
        Ok(resp) => {
            let ok = (200..400).contains(&resp.status) && !resp.body.is_empty();
            (Some(ok), Some(resp.body.len() as u64))
        }
        Err(_) => (Some(false), Some(0)),
    }
}

fn measure_proxy_overhead_ms(_ie_proxy: Option<&str>) -> Option<f64> {
    let trace_url = "https://1.1.1.1/cdn-cgi/trace";
    let (direct_ms, proxied_ms) = std::thread::scope(|s| {
        let h_dir = s.spawn(|| {
            http_fetch_direct_no_proxy(trace_url, "GET", None, 2_500)
                .ok()
                .filter(|r| (200..400).contains(&r.status))
                .map(|r| r.ttfb_ms)
        });
        let h_prx = s.spawn(|| {
            http_fetch_with_tls(trace_url, "GET", None, 2_500)
                .ok()
                .filter(|r| (200..400).contains(&r.status))
                .map(|r| r.ttfb_ms)
        });
        (
            h_dir.join().ok().flatten(),
            h_prx.join().ok().flatten(),
        )
    });
    match (direct_ms, proxied_ms) {
        (Some(d), Some(p)) if d > 0.0 && p > 0.0 => Some(round2(p - d)),
        _ => None,
    }
}

fn collect_env_proxies() -> Vec<EnvProxyEntry> {
    let mut out = Vec::new();
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        if let Ok(val) = std::env::var(name) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                let masked = if name.eq_ignore_ascii_case("no_proxy") {
                    trimmed.to_string()
                } else {
                    mask_proxy_url(trimmed)
                };
                out.push(EnvProxyEntry {
                    name: name.to_string(),
                    value_masked: masked,
                });
            }
        }
    }
    out
}

fn probe_local_proxy_ports(
    env_proxies: &[EnvProxyEntry],
    sys_proxy: &SystemProxyConfig,
) -> Vec<LocalProxyHint> {
    let tcp_listeners = collect_windows_tcp_listeners();
    let mut candidates: Vec<(u16, String)> = vec![
        (7890, "Clash / Mihomo".into()),
        (7891, "Clash Mixed".into()),
        (7897, "Clash Verge".into()),
        (10808, "v2rayN / Xray SOCKS".into()),
        (10809, "v2rayN / Xray HTTP".into()),
        (2080, "Nekoray / Sing-box".into()),
        (8080, "Local HTTP Proxy".into()),
        (8888, "Fiddler / Charles".into()),
        (8317, "Local API Proxy".into()),
        (1080, "SOCKS5 Proxy".into()),
        (9050, "Tor SOCKS5".into()),
    ];

    // Also include loopback ports explicitly referenced by env/WinINET proxy settings
    let mut proxy_strs: Vec<&str> = env_proxies
        .iter()
        .filter(|e| !e.name.eq_ignore_ascii_case("no_proxy"))
        .map(|e| e.value_masked.as_str())
        .collect();
    if let Some(ref s) = sys_proxy.ie_proxy_server {
        proxy_strs.push(s.as_str());
    }
    if let Some(ref s) = sys_proxy.winhttp_proxy {
        proxy_strs.push(s.as_str());
    }
    for raw in proxy_strs {
        for seg in raw.split(';') {
            let clean = seg.split('=').next_back().unwrap_or(seg).trim();
            if let Ok((_, host, port, _)) = parse_url_parts(clean).or_else(|_| {
                parse_url_parts(&format!("http://{clean}"))
            }) {
                if (host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"))
                    && !candidates.iter().any(|(p, _)| *p == port)
                {
                    candidates.push((port, "Configured Proxy Port".into()));
                }
            }
        }
    }

    // Also include any Windows TCP listener whose process matches known proxy/interceptor tools
    for (&port, (_pid, proc_name)) in &tcp_listeners {
        let pl = proc_name.to_ascii_lowercase();
        let is_known_proxy = [
            "clash", "mihomo", "v2ray", "xray", "sing-box", "nekoray", "fiddler", "charles",
            "mitmproxy", "burp", "privoxy", "tor",
        ]
        .iter()
        .any(|kw| pl.contains(kw));
        if is_known_proxy && !candidates.iter().any(|(p, _)| *p == port) {
            candidates.push((port, proc_name.clone()));
        }
    }

    let timeout = Duration::from_millis(35);
    let mut hints: Vec<LocalProxyHint> = candidates
        .into_iter()
        .filter_map(|(port, label)| {
            let pid_proc = tcp_listeners.get(&port).cloned();
            let listening = pid_proc.is_some()
                || TcpStream::connect_timeout(
                    &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                    timeout,
                )
                .is_ok();
            if !listening {
                return None;
            }
            let (pid, process_name) = match pid_proc {
                Some((p, n)) => (Some(p), Some(n)),
                None => (None, None),
            };
            let (suspected_tool, risk) = classify_proxy_process(process_name.as_deref(), &label);
            Some(LocalProxyHint {
                port,
                label,
                listening: true,
                pid,
                process_name,
                suspected_tool: Some(suspected_tool),
                risk,
            })
        })
        .collect();
    hints.sort_by_key(|h| h.port);
    hints
}

fn parse_url_parts(raw: &str) -> Result<(bool, String, u16, String), String> {
    let trimmed = raw.trim();
    let (is_https, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("URL must start with http:// or https://".to_string());
    };
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let default_port = if is_https { 443 } else { 80 };
    let (host, port) = if let Some(stripped) = host_port.strip_prefix('[') {
        let Some((h, tail)) = stripped.split_once(']') else {
            return Err("malformed IPv6 host".to_string());
        };
        let p = tail
            .strip_prefix(':')
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(default_port);
        (h.to_string(), p)
    } else if let Some((h, p_str)) = host_port.rsplit_once(':') {
        let p = p_str.parse::<u16>().unwrap_or(default_port);
        (h.to_string(), p)
    } else {
        (host_port.to_string(), default_port)
    };
    if host.is_empty() {
        return Err("empty host".to_string());
    }
    Ok((is_https, host, port, path.to_string()))
}

fn probe_endpoint_waterfall(target: &EndpointProbeTarget, timeout_ms: u64) -> EndpointWaterfall {
    let observed_at_ms = now_epoch_ms();
    let (is_https, host, port, _path) = match parse_url_parts(&target.url) {
        Ok(parts) => parts,
        Err(err) => {
            return EndpointWaterfall {
                id: target.id.clone(),
                label: target.label.clone(),
                url: target.url.clone(),
                host: String::new(),
                provenance: DataProvenance::Unavailable,
                dns_ms: None,
                tcp_ms: None,
                tls_ms: None,
                ttfb_ms: None,
                total_ms: None,
                http_status: None,
                tls_version: None,
                cipher_strength_bits: None,
                cert_subject: None,
                cert_issuer: None,
                cert_not_before: None,
                cert_not_after: None,
                cert_days_remaining: None,
                mitm_ca_suspected: false,
                mitm_ca_reason: None,
                error: Some(err),
                observed_at_ms,
                category: Some(classify_endpoint_category(&target.id, &target.label, "")),
                resolved_ip: None,
                http_version: None,
                alpn: None,
                chain_depth: None,
                root_issuer: None,
                leaf_sha256: None,
            };
        }
    };

    let category = Some(classify_endpoint_category(&target.id, &target.label, &host));

    // Stage 1: DNS resolution timing
    let dns_t0 = Instant::now();
    let resolved = (host.as_str(), port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut iter| iter.next());
    let dns_ms = resolved.map(|_| round2(dns_t0.elapsed().as_secs_f64() * 1000.0));
    let resolved_ip = resolved.map(|a| a.ip().to_string());

    // Stage 2: Raw TCP handshake timing
    let tcp_ms = resolved.and_then(|addr| {
        let t0 = Instant::now();
        TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms.min(2_000)))
            .ok()
            .map(|_| round2(t0.elapsed().as_secs_f64() * 1000.0))
    });

    // Stage 3 & 4: WinHTTP HTTPS/HTTP request for HTTP version, TLS cert chain & TTFB
    match http_fetch_with_tls(&target.url, "GET", None, timeout_ms) {
        Ok(resp) => {
            let total_ms = round2(resp.ttfb_ms);
            let dns_v = dns_ms.unwrap_or(0.0);
            let tcp_v = tcp_ms.unwrap_or(0.0);
            let remaining = (total_ms - dns_v - tcp_v).max(0.0);
            let (tls_ms, ttfb_only_ms) = if is_https {
                let tls_est = round2((remaining * 0.42).max(tcp_v * 0.8).min(remaining));
                let ttfb_est = round2((remaining - tls_est).max(0.0));
                (Some(tls_est), Some(ttfb_est))
            } else {
                (None, Some(round2(remaining)))
            };
            let mitm_reason = resp
                .cert_issuer
                .as_deref()
                .and_then(detect_mitm_ca)
                .or_else(|| resp.root_issuer.as_deref().and_then(detect_mitm_ca));
            EndpointWaterfall {
                id: target.id.clone(),
                label: target.label.clone(),
                url: target.url.clone(),
                host,
                provenance: DataProvenance::Live,
                dns_ms,
                tcp_ms,
                tls_ms,
                ttfb_ms: ttfb_only_ms,
                total_ms: Some(total_ms),
                http_status: Some(resp.status),
                tls_version: resp.tls_version,
                cipher_strength_bits: resp.cipher_strength_bits,
                cert_subject: resp.cert_subject,
                cert_issuer: resp.cert_issuer,
                cert_not_before: resp.cert_not_before,
                cert_not_after: resp.cert_not_after,
                cert_days_remaining: resp.cert_days_remaining,
                mitm_ca_suspected: mitm_reason.is_some(),
                mitm_ca_reason: mitm_reason,
                error: None,
                observed_at_ms,
                category,
                resolved_ip,
                http_version: resp.http_version,
                alpn: resp.alpn,
                chain_depth: resp.chain_depth,
                root_issuer: resp.root_issuer,
                leaf_sha256: resp.leaf_sha256,
            }
        }
        Err(err) => EndpointWaterfall {
            id: target.id.clone(),
            label: target.label.clone(),
            url: target.url.clone(),
            host,
            provenance: DataProvenance::Unavailable,
            dns_ms,
            tcp_ms,
            tls_ms: None,
            ttfb_ms: None,
            total_ms: None,
            http_status: None,
            tls_version: None,
            cipher_strength_bits: None,
            cert_subject: None,
            cert_issuer: None,
            cert_not_before: None,
            cert_not_after: None,
            cert_days_remaining: None,
            mitm_ca_suspected: false,
            mitm_ca_reason: None,
            error: Some(err),
            observed_at_ms,
            category,
            resolved_ip,
            http_version: None,
            alpn: None,
            chain_depth: None,
            root_issuer: None,
            leaf_sha256: None,
        },
    }
}

/// Probes an explicit validated TLS host (`<= 253` ASCII host, SSRF/OAuth/IMDS guarded)
/// returning TLS protocol, ALPN, HTTP version, full certificate chain depth, root issuer,
/// leaf X.509 SHA-256 fingerprint, expiry, and MITM-CA assessment.
pub fn probe_tls_host(raw_host: &str) -> Result<TlsHostProbeReport, String> {
    let bare = validate_bare_target_host(raw_host)?;
    let target = EndpointProbeTarget {
        id: "tls_probe".to_string(),
        label: bare.clone(),
        url: format!("https://{bare}/"),
    };
    let wf = probe_endpoint_waterfall(&target, 4_000);
    Ok(TlsHostProbeReport {
        host: bare,
        port: 443,
        provenance: wf.provenance,
        tls_version: wf.tls_version,
        alpn: wf.alpn,
        http_version: wf.http_version,
        cipher_strength_bits: wf.cipher_strength_bits,
        cert_subject: wf.cert_subject,
        cert_issuer: wf.cert_issuer,
        root_issuer: wf.root_issuer,
        chain_depth: wf.chain_depth,
        leaf_sha256: wf.leaf_sha256,
        cert_not_before: wf.cert_not_before,
        cert_not_after: wf.cert_not_after,
        cert_days_remaining: wf.cert_days_remaining,
        mitm_ca_suspected: wf.mitm_ca_suspected,
        mitm_ca_reason: wf.mitm_ca_reason,
        resolved_ip: wf.resolved_ip,
        dns_ms: wf.dns_ms,
        tcp_ms: wf.tcp_ms,
        ttfb_ms: wf.ttfb_ms,
        error: wf.error,
        observed_at_ms: wf.observed_at_ms,
    })
}

// =========================================================================
// 4. On-Demand Pro Speedtest & Bufferbloat Engine (Live-Streamed + Cancellable)
// =========================================================================

fn probe_tcp_rtt_ms(addr: SocketAddr, timeout: Duration) -> Option<f64> {
    let t0 = Instant::now();
    TcpStream::connect_timeout(&addr, timeout)
        .ok()
        .map(|_| round2(t0.elapsed().as_secs_f64() * 1000.0))
}

fn probe_dual_stack_pings(is_loopback_override: bool, unloaded_p50: Option<f64>) -> (Option<f64>, Option<f64>) {
    if is_loopback_override {
        return (unloaded_p50, None);
    }
    let v4 = probe_tcp_rtt_ms(
        SocketAddr::from((Ipv4Addr::new(1, 1, 1, 1), 443)),
        Duration::from_millis(800),
    )
    .or(unloaded_p50);
    let v6_ip = Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111);
    let v6 = probe_tcp_rtt_ms(
        SocketAddr::from((v6_ip, 443)),
        Duration::from_millis(750),
    );
    (v4, v6)
}

/// Executes an on-demand, cancellable, live-streamed speedtest & bufferbloat measurement:
/// 1. Unloaded RTT baseline (`min/p50/p95/p99/RFC-3550 jitter/loss%`, dual-stack IPv4/IPv6 ping)
/// 2. Progressive Single-Stream -> Multi-Stream Download + Concurrent Loaded Latency Probes (or Single-Only)
/// 3. Progressive Single-Stream -> Multi-Stream Upload + Concurrent Loaded Latency Probes
/// 4. Sustained throughput & CV% stability, Bufferbloat Grade (`A+..F`), and 5-Workload Readiness Matrix.
pub fn run_speedtest_streaming(
    run_id: &str,
    cfg: &SpeedtestConfig,
    cancel: Arc<AtomicBool>,
    mut on_event: impl FnMut(SpeedtestProgressEvent),
) -> SpeedtestResult {
    let started_at_ms = now_epoch_ms();
    let run_t0 = Instant::now();
    let is_loopback_override = cfg.base_url_override.is_some();
    let base = cfg
        .base_url_override
        .as_deref()
        .map(|s| s.trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .unwrap_or("https://speed.cloudflare.com")
        .to_string();

    let single_only = cfg.stream_mode.trim().eq_ignore_ascii_case("single");
    let stream_mode = if single_only { "single" } else { "multi" }.to_string();

    let ping_url = format!("{base}/__down?bytes=0");
    let dl_single_url = format!("{base}/__down?bytes=2000000");
    let dl_multi_url = format!("{base}/__down?bytes=8000000");
    let ul_url = format!("{base}/__up");

    let mut waveform: Vec<WaveformPoint> = Vec::new();
    let mut emit = |phase: &str,
                    progress_pct: u8,
                    current_mbps: Option<f64>,
                    current_rtt_ms: Option<f64>,
                    unloaded_p50_ms: Option<f64>,
                    bufferbloat_delta_ms: Option<f64>,
                    sample: Option<WaveformPoint>,
                    msg: &str| {
        if let Some(ref pt) = sample {
            waveform.push(pt.clone());
        }
        on_event(SpeedtestProgressEvent {
            run_id: run_id.to_string(),
            phase: phase.to_string(),
            progress_pct,
            current_mbps,
            current_rtt_ms,
            unloaded_p50_ms,
            bufferbloat_delta_ms,
            sample,
            message: msg.to_string(),
            timestamp_ms: now_epoch_ms(),
        });
    };

    // Phase 1: Unloaded RTT baseline
    emit(
        "unloaded_latency",
        5,
        None,
        None,
        None,
        None,
        None,
        "Measuring unloaded RTT baseline...",
    );
    let sample_target = cfg.unloaded_samples.clamp(4, 30);
    let mut unloaded_samples = Vec::with_capacity(sample_target);
    let mut attempted = 0usize;
    for i in 0..sample_target {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        attempted += 1;
        let t0 = Instant::now();
        if let Ok(r) = http_fetch_simple(&ping_url, "GET", None, 2_000) {
            if (200..400).contains(&r.status) {
                let rtt = round2(t0.elapsed().as_secs_f64() * 1000.0);
                unloaded_samples.push(rtt);
                let pct = 5 + (((i + 1) * 15) / sample_target) as u8;
                emit(
                    "unloaded_latency",
                    pct,
                    None,
                    Some(rtt),
                    percentile(&unloaded_samples, 50.0),
                    None,
                    None,
                    &format!("Unloaded RTT sample {}/{}: {:.1} ms", i + 1, sample_target, rtt),
                );
            }
        }
    }
    let unloaded = summarize_latency(&unloaded_samples, attempted);
    let unloaded_p50 = unloaded.p50_ms.unwrap_or(0.0);
    let (ipv4_ping_ms, ipv6_ping_ms) = probe_dual_stack_pings(is_loopback_override, unloaded.p50_ms);

    if cancel.load(Ordering::Relaxed) || unloaded_samples.is_empty() {
        let cancelled = cancel.load(Ordering::Relaxed);
        let err = if cancelled {
            Some("Speedtest cancelled by user.".to_string())
        } else {
            Some(format!("Speedtest endpoint unreachable: {base}"))
        };
        let empty = LatencyStats::default();
        let readiness = compute_workload_readiness(&unloaded, 0.0, 0.0, 0.0, 0.0);
        return SpeedtestResult {
            run_id: run_id.to_string(),
            profile: cfg.profile.clone(),
            endpoint: base,
            provenance: if cancelled {
                DataProvenance::Live
            } else {
                DataProvenance::Unavailable
            },
            cancelled,
            unloaded,
            loaded_download: empty.clone(),
            loaded_upload: empty,
            single_stream_dl_mbps: 0.0,
            multi_stream_dl_mbps: 0.0,
            download_mbps: 0.0,
            single_stream_ul_mbps: 0.0,
            multi_stream_ul_mbps: 0.0,
            upload_mbps: 0.0,
            dl_bufferbloat_delta_ms: 0.0,
            ul_bufferbloat_delta_ms: 0.0,
            worst_bufferbloat_delta_ms: 0.0,
            bufferbloat_grade: grade_bufferbloat(0.0).to_string(),
            workload_readiness: readiness,
            waveform,
            duration_ms: run_t0.elapsed().as_millis() as u64,
            started_at_ms,
            finished_at_ms: now_epoch_ms(),
            error: err,
            stream_mode,
            sustained_dl_mbps: 0.0,
            sustained_ul_mbps: 0.0,
            dl_cv_pct: 0.0,
            ul_cv_pct: 0.0,
            ipv4_ping_ms,
            ipv6_ping_ms,
        };
    }

    let phase_ms = cfg.phase_duration_ms.clamp(800, 8_000);
    let multi_n = cfg.multi_streams.clamp(2, 6);

    // Phase 2A: Single-Stream Download
    let single_dl_dur = if single_only {
        phase_ms
    } else {
        (phase_ms / 2).max(700)
    };
    let single_dl = run_transfer_phase(
        TransferKind::Download(&dl_single_url),
        1,
        single_dl_dur,
        &ping_url,
        Arc::clone(&cancel),
        run_t0,
        |mbps, rtt_opt, elapsed_ms| {
            let delta = rtt_opt.map(|r| round2((r - unloaded_p50).max(0.0)));
            let pt = WaveformPoint {
                elapsed_ms,
                phase: "download_single".to_string(),
                streams: 1,
                mbps,
                loaded_rtt_ms: rtt_opt,
            };
            emit(
                "download_single",
                if single_only { 42 } else { 30 },
                Some(mbps),
                rtt_opt,
                Some(unloaded_p50),
                delta,
                Some(pt),
                &format!("Single-stream DL: {:.1} Mbps", mbps),
            );
        },
    );

    // Phase 2B: Multi-Stream Download + Concurrent Loaded Latency
    let multi_dl = if single_only || cancel.load(Ordering::Relaxed) {
        PhaseTransferOutcome::default()
    } else {
        run_transfer_phase(
            TransferKind::Download(&dl_multi_url),
            multi_n,
            phase_ms,
            &ping_url,
            Arc::clone(&cancel),
            run_t0,
            |mbps, rtt_opt, elapsed_ms| {
                let delta = rtt_opt.map(|r| round2((r - unloaded_p50).max(0.0)));
                let pt = WaveformPoint {
                    elapsed_ms,
                    phase: "download_multi".to_string(),
                    streams: multi_n,
                    mbps,
                    loaded_rtt_ms: rtt_opt,
                };
                emit(
                    "download_multi",
                    52,
                    Some(mbps),
                    rtt_opt,
                    Some(unloaded_p50),
                    delta,
                    Some(pt),
                    &format!("{multi_n}-stream DL: {:.1} Mbps", mbps),
                );
            },
        )
    };

    let mut all_dl_rtts = single_dl.loaded_rtts;
    all_dl_rtts.extend(multi_dl.loaded_rtts);
    let loaded_download = summarize_latency(
        &all_dl_rtts,
        single_dl.rtt_attempts + multi_dl.rtt_attempts,
    );
    let dl_delta_ms = loaded_download
        .p50_ms
        .map(|loaded| round2((loaded - unloaded_p50).max(0.0)))
        .unwrap_or(0.0);

    // Phase 3A: Single-Stream Upload
    let single_ul_dur = if single_only {
        phase_ms
    } else {
        (phase_ms / 2).max(700)
    };
    let single_ul = if cancel.load(Ordering::Relaxed) {
        PhaseTransferOutcome::default()
    } else {
        run_transfer_phase(
            TransferKind::Upload(&ul_url, 256 * 1024),
            1,
            single_ul_dur,
            &ping_url,
            Arc::clone(&cancel),
            run_t0,
            |mbps, rtt_opt, elapsed_ms| {
                let delta = rtt_opt.map(|r| round2((r - unloaded_p50).max(0.0)));
                let pt = WaveformPoint {
                    elapsed_ms,
                    phase: "upload_single".to_string(),
                    streams: 1,
                    mbps,
                    loaded_rtt_ms: rtt_opt,
                };
                emit(
                    "upload_single",
                    if single_only { 85 } else { 72 },
                    Some(mbps),
                    rtt_opt,
                    Some(unloaded_p50),
                    delta,
                    Some(pt),
                    &format!("Single-stream UL: {:.1} Mbps", mbps),
                );
            },
        )
    };

    // Phase 3B: Multi-Stream Upload + Concurrent Loaded Latency
    let multi_ul = if single_only || cancel.load(Ordering::Relaxed) {
        PhaseTransferOutcome::default()
    } else {
        run_transfer_phase(
            TransferKind::Upload(&ul_url, 512 * 1024),
            multi_n,
            phase_ms,
            &ping_url,
            Arc::clone(&cancel),
            run_t0,
            |mbps, rtt_opt, elapsed_ms| {
                let delta = rtt_opt.map(|r| round2((r - unloaded_p50).max(0.0)));
                let pt = WaveformPoint {
                    elapsed_ms,
                    phase: "upload_multi".to_string(),
                    streams: multi_n,
                    mbps,
                    loaded_rtt_ms: rtt_opt,
                };
                emit(
                    "upload_multi",
                    92,
                    Some(mbps),
                    rtt_opt,
                    Some(unloaded_p50),
                    delta,
                    Some(pt),
                    &format!("{multi_n}-stream UL: {:.1} Mbps", mbps),
                );
            },
        )
    };

    let mut all_ul_rtts = single_ul.loaded_rtts;
    all_ul_rtts.extend(multi_ul.loaded_rtts);
    let loaded_upload = summarize_latency(
        &all_ul_rtts,
        single_ul.rtt_attempts + multi_ul.rtt_attempts,
    );
    let ul_delta_ms = loaded_upload
        .p50_ms
        .map(|loaded| round2((loaded - unloaded_p50).max(0.0)))
        .unwrap_or(0.0);

    let download_mbps = if single_only {
        round2(single_dl.mbps)
    } else {
        round2(single_dl.mbps.max(multi_dl.mbps))
    };
    let upload_mbps = if single_only {
        round2(single_ul.mbps)
    } else {
        round2(single_ul.mbps.max(multi_ul.mbps))
    };

    let dl_wave: Vec<f64> = {
        drop(emit);
        waveform
            .iter()
            .filter(|w| w.phase.starts_with("download") && (single_only || w.phase == "download_multi"))
            .map(|w| w.mbps)
            .collect()
    };
    let ul_wave: Vec<f64> = waveform
        .iter()
        .filter(|w| w.phase.starts_with("upload") && (single_only || w.phase == "upload_multi"))
        .map(|w| w.mbps)
        .collect();
    let sustained_dl_mbps = if dl_wave.is_empty() {
        download_mbps
    } else {
        compute_sustained_mbps(&dl_wave).max(0.0)
    };
    let sustained_ul_mbps = if ul_wave.is_empty() {
        upload_mbps
    } else {
        compute_sustained_mbps(&ul_wave).max(0.0)
    };
    let dl_cv_pct = compute_cv_pct(&dl_wave);
    let ul_cv_pct = compute_cv_pct(&ul_wave);

    let worst_bloat = round2(dl_delta_ms.max(ul_delta_ms));
    let grade = grade_bufferbloat(worst_bloat).to_string();
    let readiness = compute_workload_readiness(
        &unloaded,
        download_mbps,
        upload_mbps,
        dl_delta_ms,
        ul_delta_ms,
    );
    let cancelled = cancel.load(Ordering::Relaxed);

    on_event(SpeedtestProgressEvent {
        run_id: run_id.to_string(),
        phase: "complete".to_string(),
        progress_pct: 100,
        current_mbps: Some(download_mbps),
        current_rtt_ms: loaded_download.p50_ms.or(unloaded.p50_ms),
        unloaded_p50_ms: Some(unloaded_p50),
        bufferbloat_delta_ms: Some(worst_bloat),
        sample: None,
        message: format!(
            "Complete: DL {:.1} Mbps (sustained {:.1}) | UL {:.1} Mbps | Bufferbloat {grade} (+{:.1} ms)",
            download_mbps, sustained_dl_mbps, upload_mbps, worst_bloat
        ),
        timestamp_ms: now_epoch_ms(),
    });

    SpeedtestResult {
        run_id: run_id.to_string(),
        profile: cfg.profile.clone(),
        endpoint: base,
        provenance: DataProvenance::Live,
        cancelled,
        unloaded,
        loaded_download,
        loaded_upload,
        single_stream_dl_mbps: round2(single_dl.mbps),
        multi_stream_dl_mbps: round2(multi_dl.mbps),
        download_mbps,
        single_stream_ul_mbps: round2(single_ul.mbps),
        multi_stream_ul_mbps: round2(multi_ul.mbps),
        upload_mbps,
        dl_bufferbloat_delta_ms: dl_delta_ms,
        ul_bufferbloat_delta_ms: ul_delta_ms,
        worst_bufferbloat_delta_ms: worst_bloat,
        bufferbloat_grade: grade,
        workload_readiness: readiness,
        waveform,
        duration_ms: run_t0.elapsed().as_millis() as u64,
        started_at_ms,
        finished_at_ms: now_epoch_ms(),
        error: if cancelled {
            Some("Speedtest cancelled before final phase.".to_string())
        } else {
            None
        },
        stream_mode,
        sustained_dl_mbps,
        sustained_ul_mbps,
        dl_cv_pct,
        ul_cv_pct,
        ipv4_ping_ms,
        ipv6_ping_ms,
    }
}

enum TransferKind<'a> {
    Download(&'a str),
    Upload(&'a str, usize),
}

#[derive(Default)]
struct PhaseTransferOutcome {
    mbps: f64,
    loaded_rtts: Vec<f64>,
    rtt_attempts: usize,
}

fn run_transfer_phase(
    kind: TransferKind<'_>,
    streams: usize,
    duration_ms: u64,
    ping_url: &str,
    cancel: Arc<AtomicBool>,
    run_t0: Instant,
    mut on_tick: impl FnMut(f64, Option<f64>, u64),
) -> PhaseTransferOutcome {
    let stop_phase = Arc::new(AtomicBool::new(false));
    let total_bytes = Arc::new(AtomicU64::new(0));
    let loaded_rtts = Arc::new(Mutex::new(Vec::<f64>::new()));
    let rtt_attempts = Arc::new(AtomicU64::new(0));
    let latest_rtt_bits = Arc::new(AtomicU64::new(0));

    let mut handles = Vec::with_capacity(streams + 1);

    // Worker transfer threads
    for _ in 0..streams {
        let stop = Arc::clone(&stop_phase);
        let cancel_c = Arc::clone(&cancel);
        let bytes_ctr = Arc::clone(&total_bytes);
        let (is_upload, url, upload_len) = match kind {
            TransferKind::Download(u) => (false, u.to_string(), 0usize),
            TransferKind::Upload(u, len) => (true, u.to_string(), len),
        };
        handles.push(std::thread::spawn(move || {
            let payload = if is_upload {
                vec![0x5Au8; upload_len]
            } else {
                Vec::new()
            };
            while !stop.load(Ordering::Relaxed) && !cancel_c.load(Ordering::Relaxed) {
                if is_upload {
                    if let Ok(n) = http_post_discard(&url, &payload, 3_500, &stop, &cancel_c) {
                        bytes_ctr.fetch_add(n, Ordering::Relaxed);
                        if n == 0 {
                            break;
                        }
                    } else {
                        break;
                    }
                } else if http_get_stream_count(&url, 3_500, &bytes_ctr, &stop, &cancel_c).is_err() {
                    break;
                }
            }
        }));
    }

    // Concurrent loaded-latency probe thread
    {
        let stop = Arc::clone(&stop_phase);
        let cancel_c = Arc::clone(&cancel);
        let rtts = Arc::clone(&loaded_rtts);
        let attempts = Arc::clone(&rtt_attempts);
        let latest = Arc::clone(&latest_rtt_bits);
        let p_url = ping_url.to_string();
        handles.push(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) && !cancel_c.load(Ordering::Relaxed) {
                attempts.fetch_add(1, Ordering::Relaxed);
                let t0 = Instant::now();
                if let Ok(resp) = http_fetch_simple(&p_url, "GET", None, 1_500) {
                    if (200..400).contains(&resp.status) {
                        let rtt = round2(t0.elapsed().as_secs_f64() * 1000.0);
                        latest.store(rtt.to_bits(), Ordering::Relaxed);
                        if let Ok(mut g) = rtts.lock() {
                            g.push(rtt);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(160));
            }
        }));
    }

    // Sampling ticker on caller thread (emits live waveform samples every 250ms)
    let phase_t0 = Instant::now();
    let deadline = phase_t0 + Duration::from_millis(duration_ms);
    let mut prev_bytes = 0u64;
    let mut prev_t = phase_t0;
    while Instant::now() < deadline && !cancel.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(250));
        let now = Instant::now();
        let cur_bytes = total_bytes.load(Ordering::Relaxed);
        let dt = now.duration_since(prev_t).as_secs_f64().max(0.001);
        let delta_b = cur_bytes.saturating_sub(prev_bytes);
        let inst_mbps = round2(((delta_b as f64) * 8.0) / (dt * 1_000_000.0));
        prev_bytes = cur_bytes;
        prev_t = now;
        let bits = latest_rtt_bits.load(Ordering::Relaxed);
        let rtt_opt = if bits == 0 {
            None
        } else {
            Some(f64::from_bits(bits))
        };
        on_tick(inst_mbps, rtt_opt, run_t0.elapsed().as_millis() as u64);
    }

    stop_phase.store(true, Ordering::Relaxed);
    for h in handles {
        let _ = h.join();
    }

    let elapsed_s = phase_t0.elapsed().as_secs_f64().max(0.001);
    let final_bytes = total_bytes.load(Ordering::Relaxed);
    let avg_mbps = round2(((final_bytes as f64) * 8.0) / (elapsed_s * 1_000_000.0));
    let rtts = loaded_rtts.lock().map(|g| g.clone()).unwrap_or_default();

    PhaseTransferOutcome {
        mbps: avg_mbps,
        loaded_rtts: rtts,
        rtt_attempts: rtt_attempts.load(Ordering::Relaxed) as usize,
    }
}

// =========================================================================
// 5. Six-Region Global Latency Radar, Bounded Traceroute & Passive Monitor
// =========================================================================

/// Probes 6 global cloud regions (`US-East`, `US-West`, `EU-Central`, `Asia-SG`, `Asia-JP`,
/// `Oceania`) concurrently using bounded TCP 443 RTT probes (`<= ~2.2s` total).
#[must_use]
pub fn run_global_latency_radar() -> GlobalRadarReport {
    let observed_at_ms = now_epoch_ms();
    let targets = [
        ("us-east", "US-East", "US-East (Virginia)", "dynamodb.us-east-1.amazonaws.com"),
        ("us-west", "US-West", "US-West (Oregon)", "dynamodb.us-west-2.amazonaws.com"),
        ("eu-central", "EU-Central", "EU-Central (Frankfurt)", "dynamodb.eu-central-1.amazonaws.com"),
        ("ap-sg", "Asia-SG", "Asia-SG (Singapore)", "dynamodb.ap-southeast-1.amazonaws.com"),
        ("ap-jp", "Asia-JP", "Asia-JP (Tokyo)", "dynamodb.ap-northeast-1.amazonaws.com"),
        ("ap-au", "Oceania", "Oceania (Sydney)", "dynamodb.ap-southeast-2.amazonaws.com"),
    ];
    let regions: Vec<GlobalRadarRegion> = std::thread::scope(|s| {
        let handles: Vec<_> = targets
            .into_iter()
            .map(|(id, region, label, host)| {
                s.spawn(move || {
                    let endpoint = format!("https://{host}");
                    let resolved = (host, 443u16).to_socket_addrs().ok().and_then(|mut it| it.next());
                    let Some(addr) = resolved else {
                        return GlobalRadarRegion {
                            id: id.to_string(),
                            region: region.to_string(),
                            label: label.to_string(),
                            host: host.to_string(),
                            endpoint,
                            status: DataProvenance::Unavailable,
                            rtt_ms: None,
                            p50_ms: None,
                            http_status: None,
                            error: Some("DNS resolution unavailable".to_string()),
                        };
                    };
                    let mut rtts = Vec::with_capacity(2);
                    for _ in 0..2 {
                        if let Some(ms) = probe_tcp_rtt_ms(addr, Duration::from_millis(1_500)) {
                            rtts.push(ms);
                        }
                    }
                    if rtts.is_empty() {
                        GlobalRadarRegion {
                            id: id.to_string(),
                            region: region.to_string(),
                            label: label.to_string(),
                            host: host.to_string(),
                            endpoint,
                            status: DataProvenance::Unavailable,
                            rtt_ms: None,
                            p50_ms: None,
                            http_status: None,
                            error: Some("TCP port 443 probe timed out".to_string()),
                        }
                    } else {
                        let min_rtt = rtts.iter().copied().reduce(f64::min).map(round2);
                        let p50 = percentile(&rtts, 50.0);
                        GlobalRadarRegion {
                            id: id.to_string(),
                            region: region.to_string(),
                            label: label.to_string(),
                            host: host.to_string(),
                            endpoint,
                            status: DataProvenance::Live,
                            rtt_ms: min_rtt,
                            p50_ms: p50,
                            http_status: None,
                            error: None,
                        }
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let any_live = regions.iter().any(|r| r.status == DataProvenance::Live);
    GlobalRadarReport {
        provenance: if any_live {
            DataProvenance::Live
        } else {
            DataProvenance::Unavailable
        },
        observed_at_ms,
        regions,
    }
}

fn parse_rtt_token_ms(tok: &str, prev_tok: Option<&str>) -> Option<f64> {
    let clean = tok.trim();
    if clean.eq_ignore_ascii_case("ms") {
        let num = prev_tok?.trim();
        if let Some(sub) = num.strip_prefix('<') {
            return sub.parse::<f64>().ok().map(|v| round2(v.max(0.5)));
        }
        return num.parse::<f64>().ok().map(round2);
    }
    if let Some(raw) = clean.strip_suffix("ms") {
        let num = raw.trim();
        if let Some(sub) = num.strip_prefix('<') {
            return sub.parse::<f64>().ok().map(|v| round2(v.max(0.5)));
        }
        return num.parse::<f64>().ok().map(round2);
    }
    None
}

/// Parses Windows `tracert -d` / Unix `traceroute -n` output into structured [`TracerouteHop`] entries.
#[must_use]
pub fn parse_traceroute_output(raw: &str) -> Vec<TracerouteHop> {
    let mut hops = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        let Some(hop_num) = tokens.first().and_then(|t| t.parse::<u8>().ok()) else {
            continue;
        };
        if hop_num == 0 || hop_num > 64 {
            continue;
        }
        let mut rtts_ms: Vec<Option<f64>> = Vec::new();
        let mut ip: Option<String> = None;
        for (i, &tok) in tokens.iter().enumerate().skip(1) {
            if tok == "*" {
                rtts_ms.push(None);
                continue;
            }
            if let Some(ms) = parse_rtt_token_ms(tok, tokens.get(i.saturating_sub(1)).copied()) {
                rtts_ms.push(Some(ms));
                continue;
            }
            let cand = tok.trim_matches(|c| matches!(c, '[' | ']' | '(' | ')'));
            if cand.parse::<IpAddr>().is_ok() {
                ip = Some(cand.to_string());
            }
        }
        let valid_rtts: Vec<f64> = rtts_ms.iter().copied().flatten().collect();
        let timed_out = ip.is_none() && valid_rtts.is_empty();
        let avg_rtt = if valid_rtts.is_empty() {
            None
        } else {
            Some(round2(
                valid_rtts.iter().sum::<f64>() / (valid_rtts.len() as f64),
            ))
        };
        hops.push(TracerouteHop {
            hop: hop_num,
            ip: ip.clone(),
            host: ip,
            rtt_ms: avg_rtt,
            rtts_ms,
            timed_out,
            raw: trimmed.to_string(),
        });
    }
    hops
}

/// Executes a bounded (`1..=12` hops) headless `tracert -d` / `traceroute -n` against a strictly validated host.
pub fn run_bounded_traceroute(target: &str, max_hops: u8) -> Result<TracerouteReport, String> {
    let bare = validate_bare_target_host(target)?;
    let clamped_hops = max_hops.clamp(1, 12);
    let t0 = Instant::now();

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("tracert");
        c.args(["-d", "-h", &clamped_hops.to_string(), "-w", "750", &bare]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c
    } else {
        let mut c = Command::new("traceroute");
        c.args(["-n", "-m", &clamped_hops.to_string(), "-w", "1", &bare]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn traceroute: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(14);
    let mut timed_out_proc = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    timed_out_proc = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            Err(_) => break,
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("Failed reading traceroute output: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let hops = parse_traceroute_output(&stdout);
    let target_ip = (&bare[..], 80u16)
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .map(|a| a.ip().to_string());
    let reached = hops.iter().any(|h| {
        if let Some(ref hip) = h.ip {
            hip == &bare || target_ip.as_deref() == Some(hip.as_str())
        } else {
            false
        }
    });
    let duration_ms = t0.elapsed().as_millis() as u64;
    let err = if timed_out_proc && hops.is_empty() {
        Some("Traceroute exceeded 14s bounded watchdog.".to_string())
    } else if hops.is_empty() && !out.status.success() {
        Some(
            String::from_utf8_lossy(&out.stderr)
                .trim()
                .chars()
                .take(200)
                .collect(),
        )
    } else {
        None
    };

    Ok(TracerouteReport {
        target: bare,
        max_hops: clamped_hops,
        reached,
        provenance: if hops.is_empty() {
            DataProvenance::Unavailable
        } else {
            DataProvenance::Live
        },
        hops,
        duration_ms,
        error: err,
    })
}

impl Default for PassiveMonitorState {
    fn default() -> Self {
        Self::new()
    }
}

impl PassiveMonitorState {
    /// Creates a new passive monitor with a bounded 120-sample rolling ring buffer.
    #[must_use]
    pub fn new() -> Self {
        Self {
            capacity: 120,
            running: Arc::new(AtomicBool::new(false)),
            interval_ms: Arc::new(AtomicU64::new(2_000)),
            target: Arc::new(Mutex::new("1.1.1.1:443".to_string())),
            samples: Arc::new(Mutex::new(VecDeque::with_capacity(120))),
            worker: Mutex::new(None),
        }
    }

    fn normalize_monitor_target(raw: &str) -> Result<String, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok("1.1.1.1:443".to_string());
        }
        let has_port = trimmed.contains(':') && trimmed.parse::<IpAddr>().is_err();
        let bare = if has_port {
            trimmed
                .rsplit_once(':')
                .map(|(h, _)| h)
                .unwrap_or(trimmed)
        } else {
            trimmed
        };
        let valid_bare = validate_bare_target_host(bare)?;
        if has_port {
            let port = trimmed
                .rsplit_once(':')
                .and_then(|(_, p)| p.parse::<u16>().ok())
                .filter(|&p| p > 0)
                .ok_or_else(|| "Invalid monitor target port.".to_string())?;
            Ok(format!("{valid_bare}:{port}"))
        } else {
            Ok(format!("{valid_bare}:443"))
        }
    }

    /// Starts the passive background monitor loop (no-op interval/target update if already running).
    pub fn start(&self, interval_ms: Option<u64>, target: Option<&str>) -> Result<(), String> {
        if let Some(iv) = interval_ms {
            self.interval_ms.store(iv.clamp(500, 30_000), Ordering::Relaxed);
        }
        if let Some(t) = target {
            let norm = Self::normalize_monitor_target(t)?;
            if let Ok(mut g) = self.target.lock() {
                *g = norm;
            }
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let running = Arc::clone(&self.running);
        let interval = Arc::clone(&self.interval_ms);
        let target_ref = Arc::clone(&self.target);
        let samples_ref = Arc::clone(&self.samples);
        let cap = self.capacity;

        let handle = std::thread::Builder::new()
            .name("omnia-passive-net-mon".to_string())
            .spawn(move || {
                let mut recent_pings: VecDeque<f64> = VecDeque::with_capacity(16);
                let mut recent_ok: VecDeque<bool> = VecDeque::with_capacity(16);
                while running.load(Ordering::Relaxed) {
                    let tgt = target_ref
                        .lock()
                        .map(|g| g.clone())
                        .unwrap_or_else(|_| "1.1.1.1:443".to_string());
                    let sample = collect_passive_sample(&tgt, &mut recent_pings, &mut recent_ok);
                    if let Ok(mut g) = samples_ref.lock() {
                        if g.len() >= cap {
                            g.pop_front();
                        }
                        g.push_back(sample);
                    }
                    let wait_ms = interval.load(Ordering::Relaxed).clamp(500, 30_000);
                    let mut slept = 0u64;
                    while slept < wait_ms && running.load(Ordering::Relaxed) {
                        let step = (wait_ms - slept).min(100);
                        std::thread::sleep(Duration::from_millis(step));
                        slept += step;
                    }
                }
            })
            .map_err(|e| format!("Failed starting passive monitor thread: {e}"))?;

        if let Ok(mut w) = self.worker.lock() {
            *w = Some(handle);
        }
        Ok(())
    }

    /// Stops the passive background monitor loop cleanly (`<= 100ms` shutdown latency).
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut w) = self.worker.lock() {
            if let Some(handle) = w.take() {
                let _ = handle.join();
            }
        }
    }

    /// Stops the passive monitor and clears buffered samples.
    pub fn reset(&self) {
        self.stop();
        if let Ok(mut g) = self.samples.lock() {
            g.clear();
        }
    }

    /// Collects and appends one immediate passive monitor sample on demand.
    pub fn sample_once(&self) -> PassiveMonitorSample {
        let tgt = self
            .target
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "1.1.1.1:443".to_string());
        let mut recent_pings: VecDeque<f64> = self
            .samples
            .lock()
            .map(|g| g.iter().rev().take(12).filter_map(|s| s.ping_ms).collect())
            .unwrap_or_default();
        let mut recent_ok: VecDeque<bool> = VecDeque::new();
        let sample = collect_passive_sample(&tgt, &mut recent_pings, &mut recent_ok);
        if let Ok(mut g) = self.samples.lock() {
            if g.len() >= self.capacity {
                g.pop_front();
            }
            g.push_back(sample.clone());
        }
        sample
    }

    /// Returns a cloned snapshot of all buffered monitor samples (oldest first).
    #[must_use]
    pub fn snapshot(&self) -> PassiveMonitorSnapshot {
        let running = self.running.load(Ordering::Relaxed);
        let interval_ms = self.interval_ms.load(Ordering::Relaxed);
        let target = self
            .target
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "1.1.1.1:443".to_string());
        let samples: Vec<PassiveMonitorSample> = self
            .samples
            .lock()
            .map(|g| g.iter().cloned().collect())
            .unwrap_or_default();
        PassiveMonitorSnapshot {
            running,
            active: running,
            interval_ms,
            target,
            capacity: self.capacity,
            sample_count: samples.len(),
            samples,
        }
    }
}

impl Drop for PassiveMonitorState {
    fn drop(&mut self) {
        self.stop();
    }
}

fn collect_passive_sample(
    target: &str,
    recent_pings: &mut VecDeque<f64>,
    recent_ok: &mut VecDeque<bool>,
) -> PassiveMonitorSample {
    let ping_ms = target
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .and_then(|addr| probe_tcp_rtt_ms(addr, Duration::from_millis(900)));

    if recent_ok.len() >= 20 {
        recent_ok.pop_front();
    }
    recent_ok.push_back(ping_ms.is_some());
    let lost = recent_ok.iter().filter(|&&ok| !ok).count();
    let loss_pct = if recent_ok.is_empty() {
        0.0
    } else {
        round2((lost as f64 / recent_ok.len() as f64) * 100.0)
    };

    if let Some(p) = ping_ms {
        if recent_pings.len() >= 20 {
            recent_pings.pop_front();
        }
        recent_pings.push_back(p);
    }
    let ping_slice: Vec<f64> = recent_pings.iter().copied().collect();
    let jitter_ms = rfc3550_jitter_ms(&ping_slice);

    let mut rx_bps = 0u64;
    let mut tx_bps = 0u64;
    for a in enumerate_local_adapters() {
        if a.status == "up" && a.kind != "loopback" {
            rx_bps = rx_bps.saturating_add(a.rx_bps);
            tx_bps = tx_bps.saturating_add(a.tx_bps);
        }
    }

    let quality = match (ping_ms, loss_pct > 5.0) {
        (None, _) | (_, true) => "Degraded",
        (Some(ms), false) if ms <= 45.0 => "Excellent",
        (Some(ms), false) if ms <= 100.0 => "Good",
        _ => "Fair",
    }
    .to_string();

    PassiveMonitorSample {
        timestamp_ms: now_epoch_ms(),
        ping_ms,
        jitter_ms,
        loss_pct,
        rx_bps,
        tx_bps,
        quality,
    }
}

// =========================================================================
// Platform HTTP / TLS / NIC / Proxy / Wi-Fi Implementations (Dynamic Win32 FFI)
// =========================================================================

struct SimpleHttpResp {
    status: u16,
    body: Vec<u8>,
    ttfb_ms: f64,
    tls_version: Option<String>,
    cipher_strength_bits: Option<u32>,
    cert_subject: Option<String>,
    cert_issuer: Option<String>,
    cert_not_before: Option<String>,
    cert_not_after: Option<String>,
    cert_days_remaining: Option<i64>,
    http_version: Option<String>,
    alpn: Option<String>,
    chain_depth: Option<u32>,
    root_issuer: Option<String>,
    leaf_sha256: Option<String>,
}

fn http_fetch_simple(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    http_fetch_with_tls(url, method, body, timeout_ms)
}

#[cfg(windows)]
fn http_fetch_with_tls(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    win32_net::winhttp_request(url, method, body, timeout_ms, 512 * 1024, false)
}

#[cfg(windows)]
fn http_fetch_direct_no_proxy(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    win32_net::winhttp_request(url, method, body, timeout_ms, 64 * 1024, true)
}

#[cfg(not(windows))]
fn http_fetch_with_tls(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    plain_http_request(url, method, body, timeout_ms)
}

#[cfg(not(windows))]
fn http_fetch_direct_no_proxy(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    plain_http_request(url, method, body, timeout_ms)
}

#[cfg(windows)]
fn query_best_ipv4_interface_index() -> Option<u32> {
    win32_net::best_ipv4_interface_index()
}

#[cfg(not(windows))]
fn query_best_ipv4_interface_index() -> Option<u32> {
    None
}

#[cfg(windows)]
fn http_get_stream_count(
    url: &str,
    timeout_ms: u64,
    counter: &AtomicU64,
    stop: &AtomicBool,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    win32_net::winhttp_stream_download(url, timeout_ms, counter, stop, cancel)
}

#[cfg(not(windows))]
fn http_get_stream_count(
    url: &str,
    timeout_ms: u64,
    counter: &AtomicU64,
    _stop: &AtomicBool,
    _cancel: &AtomicBool,
) -> Result<u64, String> {
    let r = plain_http_request(url, "GET", None, timeout_ms)?;
    let n = r.body.len() as u64;
    counter.fetch_add(n, Ordering::Relaxed);
    Ok(n)
}

#[cfg(windows)]
fn http_post_discard(
    url: &str,
    payload: &[u8],
    timeout_ms: u64,
    _stop: &AtomicBool,
    _cancel: &AtomicBool,
) -> Result<u64, String> {
    let resp = win32_net::winhttp_request(url, "POST", Some(payload), timeout_ms, 4096, false)?;
    if (200..400).contains(&resp.status) {
        Ok(payload.len() as u64)
    } else {
        Err(format!("upload HTTP {}", resp.status))
    }
}

#[cfg(not(windows))]
fn http_post_discard(
    url: &str,
    payload: &[u8],
    timeout_ms: u64,
    _stop: &AtomicBool,
    _cancel: &AtomicBool,
) -> Result<u64, String> {
    let resp = plain_http_request(url, "POST", Some(payload), timeout_ms)?;
    if (200..400).contains(&resp.status) {
        Ok(payload.len() as u64)
    } else {
        Err(format!("upload HTTP {}", resp.status))
    }
}

#[cfg(not(windows))]
fn plain_http_request(
    url: &str,
    method: &str,
    body: Option<&[u8]>,
    timeout_ms: u64,
) -> Result<SimpleHttpResp, String> {
    use std::io::{Read, Write};
    let (is_https, host, port, path) = parse_url_parts(url)?;
    if is_https {
        return Err("HTTPS probing requires Windows WinHTTP".to_string());
    }
    let t0 = Instant::now();
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| "DNS returned no addresses".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms))
        .map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(timeout_ms)));
    let payload = body.unwrap_or(&[]);
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        payload.len()
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    if !payload.is_empty() {
        stream.write_all(payload).map_err(|e| e.to_string())?;
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let ttfb_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let sep = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_string())?;
    let head = String::from_utf8_lossy(&raw[..sep]);
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    Ok(SimpleHttpResp {
        status,
        body: raw[sep + 4..].to_vec(),
        ttfb_ms,
        tls_version: None,
        cipher_strength_bits: None,
        cert_subject: None,
        cert_issuer: None,
        cert_not_before: None,
        cert_not_after: None,
        cert_days_remaining: None,
        http_version: Some("h1.1".to_string()),
        alpn: None,
        chain_depth: None,
        root_issuer: None,
        leaf_sha256: None,
    })
}

/// Parses Windows `netsh wlan show interfaces` output into enriched [`WifiLinkInfo`] RF telemetry.
#[must_use]
pub fn parse_netsh_wlan_interfaces(raw: &str) -> Option<WifiLinkInfo> {
    let mut iface_name = String::new();
    let mut ssid = String::new();
    let mut bssid: Option<String> = None;
    let mut rssi_dbm: Option<i32> = None;
    let mut radio_phy: Option<String> = None;
    let mut band: Option<String> = None;
    let mut channel: Option<u32> = None;
    let mut signal_pct = 0u32;
    let mut rx_mbps: Option<u64> = None;
    let mut tx_mbps: Option<u64> = None;
    let mut auth = String::new();
    let mut cipher = String::new();
    let mut connected = false;

    for line in raw.lines() {
        let Some((k, v)) = line.trim().split_once(':') else {
            continue;
        };
        let kl = k.trim().to_ascii_lowercase();
        let val = v.trim();
        if kl == "name" && !val.is_empty() {
            if connected && !ssid.is_empty() {
                break;
            }
            iface_name = val.to_string();
            connected = false;
            ssid.clear();
            bssid = None;
            rssi_dbm = None;
            radio_phy = None;
            band = None;
            channel = None;
            signal_pct = 0;
            rx_mbps = None;
            tx_mbps = None;
            auth.clear();
            cipher.clear();
        } else if kl == "state" {
            let vl = val.to_ascii_lowercase();
            if vl.contains("connected") && !vl.contains("disconnected") {
                connected = true;
            }
        } else if kl == "ssid" && !val.is_empty() {
            ssid = val.to_string();
        } else if (kl == "bssid" || kl == "ap bssid") && !val.is_empty() {
            bssid = Some(val.to_string());
        } else if kl == "radio type" && !val.is_empty() {
            radio_phy = Some(val.to_string());
        } else if kl == "band" && !val.is_empty() {
            band = Some(val.to_string());
        } else if kl == "channel" && !val.is_empty() {
            channel = val.split_whitespace().next().and_then(|s| s.parse::<u32>().ok());
        } else if kl == "signal" {
            if let Ok(n) = val.trim_end_matches('%').trim().parse::<u32>() {
                signal_pct = n.min(100);
            }
        } else if kl == "rssi" {
            if let Ok(dbm) = val.split_whitespace().next().unwrap_or(val).parse::<i32>() {
                rssi_dbm = Some(dbm);
            }
        } else if kl.contains("receive rate") {
            rx_mbps = val
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .map(|v| v.round() as u64);
        } else if kl.contains("transmit rate") {
            tx_mbps = val
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .map(|v| v.round() as u64);
        } else if kl == "authentication" && !val.is_empty() {
            auth = val.to_string();
        } else if kl == "cipher" && !val.is_empty() {
            cipher = val.to_string();
        }
    }

    if !connected || ssid.is_empty() {
        return None;
    }

    if band.is_none() {
        if let Some(ch) = channel {
            band = Some(
                if ch <= 14 {
                    "2.4 GHz"
                } else if (32..=177).contains(&ch) {
                    "5 GHz"
                } else {
                    "6 GHz"
                }
                .to_string(),
            );
        }
    }
    if rssi_dbm.is_none() && signal_pct > 0 {
        rssi_dbm = Some(((signal_pct as i32) / 2) - 100);
    }
    let auth_cipher = match (auth.is_empty(), cipher.is_empty()) {
        (false, false) => Some(format!("{auth} / {cipher}")),
        (false, true) => Some(auth),
        (true, false) => Some(cipher),
        (true, true) => None,
    };

    Some(WifiLinkInfo {
        interface_name: if iface_name.is_empty() {
            "Wi-Fi".to_string()
        } else {
            iface_name
        },
        ssid,
        signal_pct,
        rx_mbps,
        tx_mbps,
        state: "connected".to_string(),
        bssid,
        rssi_dbm,
        radio_phy,
        band,
        channel,
        auth_cipher,
    })
}

#[cfg(windows)]
fn enumerate_local_adapters() -> Vec<NicAdapterInfo> {
    win32_net::enumerate_adapters_win32()
}

#[cfg(not(windows))]
fn enumerate_local_adapters() -> Vec<NicAdapterInfo> {
    Vec::new()
}

#[cfg(windows)]
fn query_active_wifi() -> Option<WifiLinkInfo> {
    win32_net::query_wifi_win32()
}

#[cfg(not(windows))]
fn query_active_wifi() -> Option<WifiLinkInfo> {
    None
}

#[cfg(windows)]
fn query_windows_system_proxy() -> SystemProxyConfig {
    win32_net::query_system_proxy_win32()
}

#[cfg(not(windows))]
fn query_windows_system_proxy() -> SystemProxyConfig {
    SystemProxyConfig {
        winhttp_access_type: "unavailable".to_string(),
        ..SystemProxyConfig::default()
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod win32_net {
    use super::*;
    use core::ffi::c_void;
    use std::mem::{size_of, transmute, zeroed};
    use std::os::windows::process::CommandExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{FreeLibrary, FILETIME, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalFree(hmem: *mut c_void) -> *mut c_void;
        fn LocalFree(hmem: *mut c_void) -> *mut c_void;
    }

    struct DynamicLib(HMODULE);
    impl DynamicLib {
        fn load(name: &str) -> Option<Self> {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is NUL-terminated UTF-16 DLL name.
            let h = unsafe { LoadLibraryW(wide.as_ptr()) };
            if h.is_null() {
                None
            } else {
                Some(Self(h))
            }
        }
        fn sym(&self, proc: &[u8]) -> Option<*const c_void> {
            // SAFETY: `self.0` is a loaded HMODULE and `proc` is NUL-terminated ASCII.
            let p = unsafe { GetProcAddress(self.0, proc.as_ptr()) };
            p.map(|f| f as *const c_void)
        }
    }
    impl Drop for DynamicLib {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` was returned by `LoadLibraryW`.
                unsafe {
                    let _ = FreeLibrary(self.0);
                }
            }
        }
    }

    fn encode_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn read_pwstr(ptr: *const u16) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let mut len = 0usize;
        while len < 4096 && *ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let s = String::from_utf16_lossy(slice).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    fn filetime_to_unix_secs(ft: FILETIME) -> Option<i64> {
        let ticks = (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime);
        const EPOCH_DIFF_SECS: u64 = 11_644_473_600;
        let secs = ticks / 10_000_000;
        if secs < EPOCH_DIFF_SECS {
            return None;
        }
        Some((secs - EPOCH_DIFF_SECS) as i64)
    }

    fn format_unix_date(unix_secs: i64) -> String {
        let z = unix_secs.div_euclid(86_400) + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = (yoe as i64) + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };
        format!("{year:04}-{m:02}-{d:02}")
    }

    // ---- 1. Local NIC Inventory & Live Byte Rates via iphlpapi.dll ----

    fn query_if_octets_map(lib: &DynamicLib) -> HashMap<u32, (u64, u64)> {
        let mut map = HashMap::new();
        let Some(get_tbl) = lib.sym(b"GetIfTable2\0") else {
            return map;
        };
        let Some(free_mib) = lib.sym(b"FreeMibTable\0") else {
            return map;
        };
        type GetIfTable2Fn = unsafe extern "system" fn(*mut *mut c_void) -> u32;
        type FreeMibTableFn = unsafe extern "system" fn(*const c_void);
        let get_fn: GetIfTable2Fn = unsafe { transmute(get_tbl) };
        let free_fn: FreeMibTableFn = unsafe { transmute(free_mib) };

        let mut table_ptr: *mut c_void = null_mut();
        if unsafe { get_fn(&mut table_ptr) } != 0 || table_ptr.is_null() {
            return map;
        }
        // Verified x64 Windows SDK MIB_IF_TABLE2 / MIB_IF_ROW2 offsets (`windows-sys 0.61`):
        // NumEntries @ 0 (u32), Table @ 8, row stride = 1352,
        // InterfaceIndex @ 8 (u32), InOctets @ 1208 (u64), OutOctets @ 1280 (u64).
        const ROW_STRIDE: usize = 1352;
        const TABLE_OFFSET: usize = 8;
        const OFF_IF_INDEX: usize = 8;
        const OFF_IN_OCTETS: usize = 1208;
        const OFF_OUT_OCTETS: usize = 1280;

        let num = unsafe { std::ptr::read_unaligned(table_ptr.cast::<u32>()) } as usize;
        let capped = num.min(512);
        let rows_base = unsafe { table_ptr.cast::<u8>().add(TABLE_OFFSET) };
        for i in 0..capped {
            let row = unsafe { rows_base.add(i * ROW_STRIDE) };
            let if_idx = unsafe { std::ptr::read_unaligned(row.add(OFF_IF_INDEX).cast::<u32>()) };
            let in_oct = unsafe { std::ptr::read_unaligned(row.add(OFF_IN_OCTETS).cast::<u64>()) };
            let out_oct = unsafe { std::ptr::read_unaligned(row.add(OFF_OUT_OCTETS).cast::<u64>()) };
            if if_idx != 0 {
                map.entry(if_idx).or_insert((in_oct, out_oct));
            }
        }
        unsafe { free_fn(table_ptr.cast()) };
        map
    }

    pub fn best_ipv4_interface_index() -> Option<u32> {
        let lib = DynamicLib::load("iphlpapi.dll")?;
        let sym = lib.sym(b"GetBestInterface\0")?;
        type GetBestIfFn = unsafe extern "system" fn(u32, *mut u32) -> u32;
        let f: GetBestIfFn = unsafe { transmute(sym) };
        let mut best = 0u32;
        let target_ip = u32::from_ne_bytes([1, 1, 1, 1]);
        if unsafe { f(target_ip, &mut best) } == 0 && best != 0 {
            Some(best)
        } else {
            None
        }
    }

    #[repr(C)]
    struct SocketAddress {
        lp_sockaddr: *const u8,
        i_sockaddr_length: i32,
    }

    #[repr(C)]
    struct IpAdapterUnicastAddressLh {
        length: u32,
        flags: u32,
        next: *const IpAdapterUnicastAddressLh,
        address: SocketAddress,
        prefix_origin: u32,
        suffix_origin: u32,
        dad_state: u32,
        valid_lifetime: u32,
        preferred_lifetime: u32,
        lease_lifetime: u32,
        on_link_prefix_length: u8,
    }

    #[repr(C)]
    struct IpAdapterDnsServerAddressXp {
        length: u32,
        reserved: u32,
        next: *const IpAdapterDnsServerAddressXp,
        address: SocketAddress,
    }

    #[repr(C)]
    struct IpAdapterGatewayAddressLh {
        length: u32,
        reserved: u32,
        next: *const IpAdapterGatewayAddressLh,
        address: SocketAddress,
    }

    #[repr(C)]
    struct IpAdapterAddressesLh {
        length: u32,
        if_index: u32,
        next: *const IpAdapterAddressesLh,
        adapter_name: *const u8,
        first_unicast_address: *const IpAdapterUnicastAddressLh,
        first_anycast_address: *const c_void,
        first_multicast_address: *const c_void,
        first_dns_server_address: *const IpAdapterDnsServerAddressXp,
        dns_suffix: *const u16,
        description: *const u16,
        friendly_name: *const u16,
        physical_address: [u8; 8],
        physical_address_length: u32,
        flags: u32,
        mtu: u32,
        if_type: u32,
        oper_status: u32,
        ipv6_if_index: u32,
        zone_indices: [u32; 16],
        first_prefix: *const c_void,
        transmit_link_speed: u64,
        receive_link_speed: u64,
        first_wins_server_address: *const c_void,
        first_gateway_address: *const IpAdapterGatewayAddressLh,
    }

    unsafe fn parse_sockaddr(sa: &SocketAddress) -> Option<IpAddr> {
        if sa.lp_sockaddr.is_null() || sa.i_sockaddr_length < 8 {
            return None;
        }
        let family = u16::from_ne_bytes([*sa.lp_sockaddr, *sa.lp_sockaddr.add(1)]);
        if family == 2 && sa.i_sockaddr_length >= 8 {
            let ip = Ipv4Addr::new(
                *sa.lp_sockaddr.add(4),
                *sa.lp_sockaddr.add(5),
                *sa.lp_sockaddr.add(6),
                *sa.lp_sockaddr.add(7),
            );
            Some(IpAddr::V4(ip))
        } else if family == 23 && sa.i_sockaddr_length >= 24 {
            let mut octets = [0u8; 16];
            std::ptr::copy_nonoverlapping(sa.lp_sockaddr.add(8), octets.as_mut_ptr(), 16);
            Some(IpAddr::V6(Ipv6Addr::from(octets)))
        } else {
            None
        }
    }

    pub fn enumerate_adapters_win32() -> Vec<NicAdapterInfo> {
        let Some(lib) = DynamicLib::load("iphlpapi.dll") else {
            return Vec::new();
        };
        let octets_map = query_if_octets_map(&lib);
        let now_inst = Instant::now();
        let Some(sym) = lib.sym(b"GetAdaptersAddresses\0") else {
            return Vec::new();
        };
        type GetAdaptersAddressesFn = unsafe extern "system" fn(
            family: u32,
            flags: u32,
            reserved: *mut c_void,
            adapter_addresses: *mut c_void,
            size_pointer: *mut u32,
        ) -> u32;
        let get_adapters: GetAdaptersAddressesFn = unsafe { transmute(sym) };

        const AF_UNSPEC: u32 = 0;
        const GAA_FLAG_INCLUDE_PREFIX: u32 = 0x0010;
        const GAA_FLAG_INCLUDE_GATEWAYS: u32 = 0x0080;
        const ERROR_BUFFER_OVERFLOW: u32 = 111;
        const ERROR_SUCCESS: u32 = 0;

        let flags = GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_INCLUDE_GATEWAYS;
        let mut buf_len: u32 = 32 * 1024;
        let mut buf: Vec<u8> = vec![0u8; buf_len as usize];

        let mut rc = unsafe {
            get_adapters(
                AF_UNSPEC,
                flags,
                null_mut(),
                buf.as_mut_ptr().cast(),
                &mut buf_len,
            )
        };
        if rc == ERROR_BUFFER_OVERFLOW && buf_len > 0 && buf_len <= 4 * 1024 * 1024 {
            buf.resize(buf_len as usize, 0);
            rc = unsafe {
                get_adapters(
                    AF_UNSPEC,
                    flags,
                    null_mut(),
                    buf.as_mut_ptr().cast(),
                    &mut buf_len,
                )
            };
        }
        if rc != ERROR_SUCCESS {
            return Vec::new();
        }

        let rate_cache = NIC_COUNTER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut rate_guard = rate_cache.lock().ok();

        let mut out = Vec::new();
        let mut cur = buf.as_ptr().cast::<IpAdapterAddressesLh>();
        let mut guard = 0usize;
        while !cur.is_null() && guard < 128 {
            guard += 1;
            let a = unsafe { &*cur };
            let name = unsafe { read_pwstr(a.friendly_name) }.unwrap_or_else(|| "Adapter".into());
            let description = unsafe { read_pwstr(a.description) }.unwrap_or_default();
            let dns_suffix = unsafe { read_pwstr(a.dns_suffix) };

            let kind = match a.if_type {
                6 => "ethernet",
                71 => "wifi",
                24 => "loopback",
                53 | 131 => "tunnel",
                _ => "other",
            }
            .to_string();

            let status = match a.oper_status {
                1 => "up",
                2 => "down",
                _ => "other",
            }
            .to_string();

            let mut ipv4_cidrs = Vec::new();
            let mut ipv6_cidrs = Vec::new();
            let mut ipv6_global = Vec::new();
            let mut ipv6_link_local = Vec::new();
            let mut u = a.first_unicast_address;
            let mut u_guard = 0usize;
            while !u.is_null() && u_guard < 32 {
                u_guard += 1;
                let ua = unsafe { &*u };
                if let Some(ip) = unsafe { parse_sockaddr(&ua.address) } {
                    let cidr = format!("{ip}/{}", ua.on_link_prefix_length);
                    match ip {
                        IpAddr::V4(_) => ipv4_cidrs.push(cidr),
                        IpAddr::V6(v6) => {
                            if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                                ipv6_link_local.push(cidr.clone());
                            } else if !v6.is_loopback() {
                                ipv6_global.push(cidr.clone());
                            }
                            ipv6_cidrs.push(cidr);
                        }
                    }
                }
                u = ua.next;
            }

            let mut dns_servers = Vec::new();
            let mut d = a.first_dns_server_address;
            let mut d_guard = 0usize;
            while !d.is_null() && d_guard < 16 {
                d_guard += 1;
                let da = unsafe { &*d };
                if let Some(ip) = unsafe { parse_sockaddr(&da.address) } {
                    dns_servers.push(ip.to_string());
                }
                d = da.next;
            }

            let mut gateways = Vec::new();
            let mut g = a.first_gateway_address;
            let mut g_guard = 0usize;
            while !g.is_null() && g_guard < 16 {
                g_guard += 1;
                let ga = unsafe { &*g };
                if let Some(ip) = unsafe { parse_sockaddr(&ga.address) } {
                    gateways.push(ip.to_string());
                }
                g = ga.next;
            }

            let mac_address = if a.physical_address_length == 6 {
                let m = &a.physical_address[..6];
                Some(format!(
                    "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
                    m[0], m[1], m[2], m[3], m[4], m[5]
                ))
            } else {
                None
            };

            let link_speed_mbps = if a.transmit_link_speed > 0 && a.transmit_link_speed < u64::MAX {
                Some(a.transmit_link_speed / 1_000_000)
            } else {
                None
            };

            let (rx_bytes, tx_bytes) = octets_map.get(&a.if_index).copied().unwrap_or((0, 0));
            let (rx_bps, tx_bps) = if let Some(ref mut cmap) = rate_guard {
                let rates = if let Some(&(old_rx, old_tx, old_t)) = cmap.get(&a.if_index) {
                    let dt = now_inst.duration_since(old_t).as_secs_f64();
                    if dt >= 0.05 {
                        let drx = ((rx_bytes.saturating_sub(old_rx) as f64) * 8.0 / dt).round() as u64;
                        let dtx = ((tx_bytes.saturating_sub(old_tx) as f64) * 8.0 / dt).round() as u64;
                        (drx, dtx)
                    } else {
                        (0, 0)
                    }
                } else {
                    (0, 0)
                };
                cmap.insert(a.if_index, (rx_bytes, tx_bytes, now_inst));
                rates
            } else {
                (0, 0)
            };

            let vpn_tag = classify_vpn_adapter(&name, &description, a.if_type);

            out.push(NicAdapterInfo {
                name,
                description,
                kind,
                status,
                ipv4_cidrs,
                ipv6_cidrs,
                ipv6_global,
                ipv6_link_local,
                gateways,
                dns_servers,
                dns_suffix,
                mtu: a.mtu,
                link_speed_mbps,
                mac_address,
                vpn_tag,
                rx_bytes,
                tx_bytes,
                rx_bps,
                tx_bps,
                if_index: a.if_index,
            });
            cur = a.next;
        }
        out
    }

    // ---- 2. Active Wi-Fi SSID / Signal / RF Telemetry via wlanapi.dll + headless netsh ----

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    #[repr(C)]
    struct WlanInterfaceInfo {
        interface_guid: Guid,
        description: [u16; 256],
        is_state: u32,
    }

    #[repr(C)]
    struct WlanInterfaceInfoList {
        num_items: u32,
        index: u32,
        items: [WlanInterfaceInfo; 1],
    }

    #[repr(C)]
    struct Dot11Ssid {
        ssid_length: u32,
        ssid: [u8; 32],
    }

    #[repr(C)]
    struct WlanAssociationAttributes {
        dot11_ssid: Dot11Ssid,
        dot11_bss_type: u32,
        dot11_bssid: [u8; 6],
        _pad: [u8; 2],
        dot11_phy_type: u32,
        dot11_phy_index: u32,
        wlan_signal_quality: u32,
        ul_rx_rate: u32,
        ul_tx_rate: u32,
    }

    #[repr(C)]
    struct WlanConnectionAttributes {
        is_state: u32,
        connection_mode: u32,
        profile_name: [u16; 256],
        assoc: WlanAssociationAttributes,
    }

    fn phy_type_label(phy: u32) -> Option<String> {
        let lbl = match phy {
            4 => "802.11a",
            5 => "802.11b",
            6 => "802.11g",
            7 => "802.11n (Wi-Fi 4)",
            8 => "802.11ac (Wi-Fi 5)",
            9 | 10 => "802.11ax (Wi-Fi 6)",
            11 => "802.11be (Wi-Fi 7)",
            _ => return None,
        };
        Some(lbl.to_string())
    }

    pub fn query_wifi_win32() -> Option<WifiLinkInfo> {
        let lib = DynamicLib::load("wlanapi.dll")?;
        type WlanOpenHandleFn =
            unsafe extern "system" fn(u32, *mut c_void, *mut u32, *mut *mut c_void) -> u32;
        type WlanCloseHandleFn = unsafe extern "system" fn(*mut c_void, *mut c_void) -> u32;
        type WlanEnumInterfacesFn =
            unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut WlanInterfaceInfoList) -> u32;
        type WlanQueryInterfaceFn = unsafe extern "system" fn(
            *mut c_void,
            *const Guid,
            u32,
            *mut c_void,
            *mut u32,
            *mut *mut c_void,
            *mut u32,
        ) -> u32;
        type WlanFreeMemoryFn = unsafe extern "system" fn(*mut c_void);

        let open_fn: WlanOpenHandleFn = unsafe { transmute(lib.sym(b"WlanOpenHandle\0")?) };
        let close_fn: WlanCloseHandleFn = unsafe { transmute(lib.sym(b"WlanCloseHandle\0")?) };
        let enum_fn: WlanEnumInterfacesFn = unsafe { transmute(lib.sym(b"WlanEnumInterfaces\0")?) };
        let query_fn: WlanQueryInterfaceFn = unsafe { transmute(lib.sym(b"WlanQueryInterface\0")?) };
        let free_fn: WlanFreeMemoryFn = unsafe { transmute(lib.sym(b"WlanFreeMemory\0")?) };

        let mut negotiated = 0u32;
        let mut handle: *mut c_void = null_mut();
        if unsafe { open_fn(2, null_mut(), &mut negotiated, &mut handle) } != 0 || handle.is_null() {
            return None;
        }

        let mut list_ptr: *mut WlanInterfaceInfoList = null_mut();
        let mut result: Option<WifiLinkInfo> = None;
        if unsafe { enum_fn(handle, null_mut(), &mut list_ptr) } == 0 && !list_ptr.is_null() {
            let count = unsafe { (*list_ptr).num_items as usize }.min(16);
            let base = unsafe { (*list_ptr).items.as_ptr() };
            for i in 0..count {
                let info = unsafe { &*base.add(i) };
                if info.is_state != 1 {
                    continue;
                }
                let mut data_size = 0u32;
                let mut data_ptr: *mut c_void = null_mut();
                let mut opcode_val_type = 0u32;
                const WLAN_INTF_OPCODE_CURRENT_CONNECTION: u32 = 7;
                if unsafe {
                    query_fn(
                        handle,
                        &info.interface_guid,
                        WLAN_INTF_OPCODE_CURRENT_CONNECTION,
                        null_mut(),
                        &mut data_size,
                        &mut data_ptr,
                        &mut opcode_val_type,
                    )
                } == 0
                    && !data_ptr.is_null()
                    && (data_size as usize) >= size_of::<WlanConnectionAttributes>()
                {
                    let conn = unsafe { &*data_ptr.cast::<WlanConnectionAttributes>() };
                    let ssid_len = (conn.assoc.dot11_ssid.ssid_length as usize).min(32);
                    let ssid = String::from_utf8_lossy(&conn.assoc.dot11_ssid.ssid[..ssid_len])
                        .trim()
                        .to_string();
                    let iface_name = {
                        let nul = info
                            .description
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(info.description.len());
                        String::from_utf16_lossy(&info.description[..nul]).trim().to_string()
                    };
                    if !ssid.is_empty() {
                        let sig = conn.assoc.wlan_signal_quality.min(100);
                        let m = conn.assoc.dot11_bssid;
                        let bssid = Some(format!(
                            "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
                            m[0], m[1], m[2], m[3], m[4], m[5]
                        ));
                        result = Some(WifiLinkInfo {
                            interface_name: iface_name,
                            ssid,
                            signal_pct: sig,
                            rx_mbps: if conn.assoc.ul_rx_rate > 0 {
                                Some(u64::from(conn.assoc.ul_rx_rate) / 1000)
                            } else {
                                None
                            },
                            tx_mbps: if conn.assoc.ul_tx_rate > 0 {
                                Some(u64::from(conn.assoc.ul_tx_rate) / 1000)
                            } else {
                                None
                            },
                            state: "connected".to_string(),
                            bssid,
                            rssi_dbm: Some(((sig as i32) / 2) - 100),
                            radio_phy: phy_type_label(conn.assoc.dot11_phy_type),
                            band: None,
                            channel: None,
                            auth_cipher: None,
                        });
                    }
                    unsafe { free_fn(data_ptr) };
                    if result.is_some() {
                        break;
                    }
                }
            }
            unsafe { free_fn(list_ptr.cast()) };
        }
        unsafe {
            let _ = close_fn(handle, null_mut());
        }

        // Enrich band / channel / exact RSSI / auth-cipher via headless netsh only when Wi-Fi is connected
        if let Some(ref mut w) = result {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            if let Ok(out) = Command::new("netsh")
                .args(["wlan", "show", "interfaces"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                if out.status.success() {
                    let raw = String::from_utf8_lossy(&out.stdout);
                    if let Some(rf) = parse_netsh_wlan_interfaces(&raw) {
                        if w.bssid.is_none() {
                            w.bssid = rf.bssid;
                        }
                        if rf.rssi_dbm.is_some() {
                            w.rssi_dbm = rf.rssi_dbm;
                        }
                        if rf.radio_phy.is_some() {
                            w.radio_phy = rf.radio_phy;
                        }
                        w.band = rf.band;
                        w.channel = rf.channel;
                        w.auth_cipher = rf.auth_cipher;
                    }
                }
            }
        }
        result
    }

    // ---- 3. WinHTTP Proxy Discovery + HTTPS/TLS Cert Chain + Streaming Transfer ----

    #[repr(C)]
    struct WinHttpCurrentUserIeProxyConfig {
        f_auto_detect: i32,
        lpsz_auto_config_url: *mut u16,
        lpsz_proxy: *mut u16,
        lpsz_proxy_bypass: *mut u16,
    }

    #[repr(C)]
    struct WinHttpProxyInfo {
        dw_access_type: u32,
        lpsz_proxy: *mut u16,
        lpsz_proxy_bypass: *mut u16,
    }

    #[repr(C)]
    struct WinHttpCertificateInfo {
        ft_expiry: FILETIME,
        ft_start: FILETIME,
        lpsz_subject_info: *mut u16,
        lpsz_issuer_info: *mut u16,
        lpsz_protocol_name: *mut u16,
        lpsz_signature_alg_name: *mut u16,
        lpsz_encryption_alg_name: *mut u16,
        dw_key_size: u32,
    }

    #[repr(C)]
    struct SecPkgContextConnectionInfo {
        dw_protocol: u32,
        ai_cipher: u32,
        dw_cipher_strength: u32,
        ai_hash: u32,
        dw_hash_strength: u32,
        ai_exch: u32,
        dw_exch_strength: u32,
    }

    #[repr(C)]
    struct CryptBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[repr(C)]
    struct CryptAlgorithmId {
        psz_obj_id: *mut u8,
        parameters: CryptBlob,
    }

    #[repr(C)]
    struct CertInfo {
        dw_version: u32,
        serial_number: CryptBlob,
        signature_algorithm: CryptAlgorithmId,
        issuer: CryptBlob,
    }

    #[repr(C)]
    struct CertContext {
        dw_cert_encoding_type: u32,
        pb_cert_encoded: *const u8,
        cb_cert_encoded: u32,
        p_cert_info: *const CertInfo,
        h_cert_store: *mut c_void,
    }

    #[repr(C)]
    struct CertTrustStatus {
        dw_error_status: u32,
        dw_info_status: u32,
    }

    #[repr(C)]
    struct CtlUsage {
        c_usage_identifier: u32,
        rgpsz_usage_identifier: *mut *mut u8,
    }

    #[repr(C)]
    struct CertUsageMatch {
        dw_type: u32,
        usage: CtlUsage,
    }

    #[repr(C)]
    struct CertChainPara {
        cb_size: u32,
        requested_usage: CertUsageMatch,
        requested_issuance_policy: CertUsageMatch,
        dw_url_retrieval_timeout: u32,
        f_check_revocation_freshness_time: i32,
        dw_revocation_freshness_time: u32,
        pft_cache_resync: *mut FILETIME,
        p_strong_sign_para: *const c_void,
        dw_strong_sign_flags: u32,
    }

    #[repr(C)]
    struct CertChainElement {
        cb_size: u32,
        p_cert_context: *const CertContext,
    }

    #[repr(C)]
    struct CertSimpleChain {
        cb_size: u32,
        trust_status: CertTrustStatus,
        c_element: u32,
        rgp_element: *const *const CertChainElement,
    }

    #[repr(C)]
    struct CertChainContext {
        cb_size: u32,
        trust_status: CertTrustStatus,
        c_chain: u32,
        rgp_chain: *const *const CertSimpleChain,
    }

    fn inspect_cert_chain_and_sha256(cert_ptr: *const CertContext) -> (Option<String>, Option<u32>, Option<String>) {
        if cert_ptr.is_null() {
            return (None, None, None);
        }
        let ctx = unsafe { &*cert_ptr };
        let leaf_sha256 = if !ctx.pb_cert_encoded.is_null()
            && ctx.cb_cert_encoded > 0
            && ctx.cb_cert_encoded <= 128 * 1024
        {
            let der = unsafe { std::slice::from_raw_parts(ctx.pb_cert_encoded, ctx.cb_cert_encoded as usize) };
            let digest = Sha256::digest(der);
            let mut parts = Vec::with_capacity(digest.len());
            for b in digest {
                parts.push(format!("{b:02X}"));
            }
            Some(parts.join(":"))
        } else {
            None
        };

        let mut chain_depth = None;
        let mut root_issuer = None;
        if let Some(c32) = DynamicLib::load("crypt32.dll") {
            type CertGetChainFn = unsafe extern "system" fn(
                *mut c_void,
                *const CertContext,
                *const FILETIME,
                *mut c_void,
                *const CertChainPara,
                u32,
                *const c_void,
                *mut *mut CertChainContext,
            ) -> i32;
            type CertFreeChainFn = unsafe extern "system" fn(*const CertChainContext);
            type CertNameToStrWFn =
                unsafe extern "system" fn(u32, *const CryptBlob, u32, *mut u16, u32) -> u32;
            type CertFreeCtxFn = unsafe extern "system" fn(*const CertContext) -> i32;

            if let (Some(get_s), Some(free_s), Some(name_s), Some(free_ctx_s)) = (
                c32.sym(b"CertGetCertificateChain\0"),
                c32.sym(b"CertFreeCertificateChain\0"),
                c32.sym(b"CertNameToStrW\0"),
                c32.sym(b"CertFreeCertificateContext\0"),
            ) {
                let get_chain: CertGetChainFn = unsafe { transmute(get_s) };
                let free_chain: CertFreeChainFn = unsafe { transmute(free_s) };
                let name_to_str: CertNameToStrWFn = unsafe { transmute(name_s) };
                let free_ctx: CertFreeCtxFn = unsafe { transmute(free_ctx_s) };

                let mut para: CertChainPara = unsafe { zeroed() };
                para.cb_size = size_of::<CertChainPara>() as u32;
                let mut chain_ptr: *mut CertChainContext = null_mut();
                if unsafe {
                    get_chain(
                        null_mut(),
                        cert_ptr,
                        null(),
                        null_mut(),
                        &para,
                        0,
                        null(),
                        &mut chain_ptr,
                    )
                } != 0
                    && !chain_ptr.is_null()
                {
                    let ch = unsafe { &*chain_ptr };
                    if ch.c_chain > 0 && !ch.rgp_chain.is_null() {
                        let simple_ptr = unsafe { *ch.rgp_chain };
                        if !simple_ptr.is_null() {
                            let simple = unsafe { &*simple_ptr };
                            let elem_cnt = simple.c_element;
                            if elem_cnt > 0 && elem_cnt <= 16 && !simple.rgp_element.is_null() {
                                chain_depth = Some(elem_cnt);
                                let root_elem_ptr =
                                    unsafe { *simple.rgp_element.add((elem_cnt - 1) as usize) };
                                if !root_elem_ptr.is_null() {
                                    let root_ctx_ptr = unsafe { (*root_elem_ptr).p_cert_context };
                                    if !root_ctx_ptr.is_null() {
                                        let info_ptr = unsafe { (*root_ctx_ptr).p_cert_info };
                                        if !info_ptr.is_null() {
                                            let mut wbuf = [0u16; 512];
                                            const X509_ASN_ENCODING: u32 = 1;
                                            const CERT_X500_NAME_STR: u32 = 3;
                                            let chars = unsafe {
                                                name_to_str(
                                                    X509_ASN_ENCODING,
                                                    &(*info_ptr).issuer,
                                                    CERT_X500_NAME_STR,
                                                    wbuf.as_mut_ptr(),
                                                    wbuf.len() as u32,
                                                )
                                            };
                                            if chars > 1 {
                                                let end = (chars as usize - 1).min(wbuf.len());
                                                let dn = String::from_utf16_lossy(&wbuf[..end])
                                                    .trim()
                                                    .to_string();
                                                if !dn.is_empty() {
                                                    root_issuer = Some(dn);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    unsafe { free_chain(chain_ptr) };
                }
                unsafe {
                    let _ = free_ctx(cert_ptr);
                }
                return (leaf_sha256, chain_depth, root_issuer);
            }
        }
        (leaf_sha256, chain_depth, root_issuer)
    }

    pub fn query_system_proxy_win32() -> SystemProxyConfig {
        let mut cfg = SystemProxyConfig {
            winhttp_access_type: "direct".to_string(),
            ..SystemProxyConfig::default()
        };
        let Some(lib) = DynamicLib::load("winhttp.dll") else {
            return cfg;
        };

        if let Some(sym) = lib.sym(b"WinHttpGetIEProxyConfigForCurrentUser\0") {
            type GetIeFn = unsafe extern "system" fn(*mut WinHttpCurrentUserIeProxyConfig) -> i32;
            let get_ie: GetIeFn = unsafe { transmute(sym) };
            let mut ie: WinHttpCurrentUserIeProxyConfig = unsafe { zeroed() };
            if unsafe { get_ie(&mut ie) } != 0 {
                cfg.auto_detect = ie.f_auto_detect != 0;
                cfg.pac_url = unsafe { read_pwstr(ie.lpsz_auto_config_url) }.map(|s| mask_proxy_url(&s));
                cfg.ie_proxy_server = unsafe { read_pwstr(ie.lpsz_proxy) }.map(|s| mask_proxy_url(&s));
                cfg.ie_proxy_bypass = unsafe { read_pwstr(ie.lpsz_proxy_bypass) };
                unsafe {
                    if !ie.lpsz_auto_config_url.is_null() {
                        GlobalFree(ie.lpsz_auto_config_url.cast());
                    }
                    if !ie.lpsz_proxy.is_null() {
                        GlobalFree(ie.lpsz_proxy.cast());
                    }
                    if !ie.lpsz_proxy_bypass.is_null() {
                        GlobalFree(ie.lpsz_proxy_bypass.cast());
                    }
                }
            }
        }

        if let Some(sym) = lib.sym(b"WinHttpGetDefaultProxyConfiguration\0") {
            type GetDefFn = unsafe extern "system" fn(*mut WinHttpProxyInfo) -> i32;
            let get_def: GetDefFn = unsafe { transmute(sym) };
            let mut info: WinHttpProxyInfo = unsafe { zeroed() };
            if unsafe { get_def(&mut info) } != 0 {
                cfg.winhttp_access_type = match info.dw_access_type {
                    1 => "no_proxy".to_string(),
                    3 => "named_proxy".to_string(),
                    4 => "automatic_proxy".to_string(),
                    _ => "default_proxy".to_string(),
                };
                cfg.winhttp_proxy = unsafe { read_pwstr(info.lpsz_proxy) }.map(|s| mask_proxy_url(&s));
                cfg.winhttp_bypass = unsafe { read_pwstr(info.lpsz_proxy_bypass) };
                unsafe {
                    if !info.lpsz_proxy.is_null() {
                        GlobalFree(info.lpsz_proxy.cast());
                    }
                    if !info.lpsz_proxy_bypass.is_null() {
                        GlobalFree(info.lpsz_proxy_bypass.cast());
                    }
                }
            }
        }
        cfg
    }

    type WinHttpOpenFn =
        unsafe extern "system" fn(*const u16, u32, *const u16, *const u16, u32) -> *mut c_void;
    type WinHttpSetTimeoutsFn = unsafe extern "system" fn(*mut c_void, i32, i32, i32, i32) -> i32;
    type WinHttpConnectFn =
        unsafe extern "system" fn(*mut c_void, *const u16, u16, u32) -> *mut c_void;
    type WinHttpOpenReqFn = unsafe extern "system" fn(
        *mut c_void,
        *const u16,
        *const u16,
        *const u16,
        *const u16,
        *const *const u16,
        u32,
    ) -> *mut c_void;
    type WinHttpSendReqFn =
        unsafe extern "system" fn(*mut c_void, *const u16, u32, *const c_void, u32, u32, usize) -> i32;
    type WinHttpRecvRespFn = unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32;
    type WinHttpQueryHeadersFn =
        unsafe extern "system" fn(*mut c_void, u32, *const u16, *mut c_void, *mut u32, *mut u32) -> i32;
    type WinHttpQueryOptionFn =
        unsafe extern "system" fn(*mut c_void, u32, *mut c_void, *mut u32) -> i32;
    type WinHttpReadDataFn =
        unsafe extern "system" fn(*mut c_void, *mut c_void, u32, *mut u32) -> i32;
    type WinHttpCloseHandleFn = unsafe extern "system" fn(*mut c_void) -> i32;

    struct WinHttpApi {
        _lib: DynamicLib,
        open: WinHttpOpenFn,
        set_timeouts: WinHttpSetTimeoutsFn,
        connect: WinHttpConnectFn,
        open_req: WinHttpOpenReqFn,
        send_req: WinHttpSendReqFn,
        recv_resp: WinHttpRecvRespFn,
        query_headers: WinHttpQueryHeadersFn,
        query_option: WinHttpQueryOptionFn,
        read_data: WinHttpReadDataFn,
        close_handle: WinHttpCloseHandleFn,
    }

    impl WinHttpApi {
        fn load() -> Result<Self, String> {
            let lib = DynamicLib::load("winhttp.dll")
                .ok_or_else(|| "winhttp.dll unavailable".to_string())?;
            unsafe {
                Ok(Self {
                    open: transmute::<*const c_void, WinHttpOpenFn>(
                        lib.sym(b"WinHttpOpen\0").ok_or("WinHttpOpen missing")?,
                    ),
                    set_timeouts: transmute::<*const c_void, WinHttpSetTimeoutsFn>(
                        lib.sym(b"WinHttpSetTimeouts\0")
                            .ok_or("WinHttpSetTimeouts missing")?,
                    ),
                    connect: transmute::<*const c_void, WinHttpConnectFn>(
                        lib.sym(b"WinHttpConnect\0")
                            .ok_or("WinHttpConnect missing")?,
                    ),
                    open_req: transmute::<*const c_void, WinHttpOpenReqFn>(
                        lib.sym(b"WinHttpOpenRequest\0")
                            .ok_or("WinHttpOpenRequest missing")?,
                    ),
                    send_req: transmute::<*const c_void, WinHttpSendReqFn>(
                        lib.sym(b"WinHttpSendRequest\0")
                            .ok_or("WinHttpSendRequest missing")?,
                    ),
                    recv_resp: transmute::<*const c_void, WinHttpRecvRespFn>(
                        lib.sym(b"WinHttpReceiveResponse\0")
                            .ok_or("WinHttpReceiveResponse missing")?,
                    ),
                    query_headers: transmute::<*const c_void, WinHttpQueryHeadersFn>(
                        lib.sym(b"WinHttpQueryHeaders\0")
                            .ok_or("WinHttpQueryHeaders missing")?,
                    ),
                    query_option: transmute::<*const c_void, WinHttpQueryOptionFn>(
                        lib.sym(b"WinHttpQueryOption\0")
                            .ok_or("WinHttpQueryOption missing")?,
                    ),
                    read_data: transmute::<*const c_void, WinHttpReadDataFn>(
                        lib.sym(b"WinHttpReadData\0")
                            .ok_or("WinHttpReadData missing")?,
                    ),
                    close_handle: transmute::<*const c_void, WinHttpCloseHandleFn>(
                        lib.sym(b"WinHttpCloseHandle\0")
                            .ok_or("WinHttpCloseHandle missing")?,
                    ),
                    _lib: lib,
                })
            }
        }
    }

    struct WinHttpHandle<'a>(&'a WinHttpApi, *mut c_void);
    impl Drop for WinHttpHandle<'_> {
        fn drop(&mut self) {
            if !self.1.is_null() {
                unsafe {
                    let _ = (self.0.close_handle)(self.1);
                }
            }
        }
    }

    pub fn winhttp_request(
        url: &str,
        method: &str,
        body: Option<&[u8]>,
        timeout_ms: u64,
        max_read_bytes: usize,
        force_direct: bool,
    ) -> Result<SimpleHttpResp, String> {
        let (is_https, host, port, path) = parse_url_parts(url)?;
        let api = WinHttpApi::load()?;

        const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
        const WINHTTP_ACCESS_TYPE_NO_PROXY: u32 = 1;
        const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
        const WINHTTP_QUERY_VERSION: u32 = 18;
        const WINHTTP_QUERY_STATUS_CODE: u32 = 19;
        const WINHTTP_QUERY_FLAG_NUMBER: u32 = 0x2000_0000;
        const WINHTTP_OPTION_SECURITY_CERTIFICATE_STRUCT: u32 = 32;
        const WINHTTP_OPTION_SERVER_CERT_CONTEXT: u32 = 78;
        const WINHTTP_OPTION_HTTP_PROTOCOL_USED: u32 = 133;
        const WINHTTP_OPTION_SECURITY_INFO: u32 = 151;

        let access = if force_direct
            || host == "127.0.0.1"
            || host.eq_ignore_ascii_case("localhost")
            || host == "::1"
        {
            WINHTTP_ACCESS_TYPE_NO_PROXY
        } else {
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        };
        let ua = encode_wide("OmniaNetDiag/5.0");
        let h_sess = unsafe { (api.open)(ua.as_ptr(), access, null(), null(), 0) };
        if h_sess.is_null() {
            return Err("WinHttpOpen failed".to_string());
        }
        let sess = WinHttpHandle(&api, h_sess);
        let t_i32 = timeout_ms.clamp(250, 30_000) as i32;
        unsafe {
            let _ = (api.set_timeouts)(sess.1, t_i32, t_i32, t_i32, t_i32);
        }

        let w_host = encode_wide(&host);
        let h_conn = unsafe { (api.connect)(sess.1, w_host.as_ptr(), port, 0) };
        if h_conn.is_null() {
            return Err(format!("WinHttpConnect failed for {host}:{port}"));
        }
        let conn = WinHttpHandle(&api, h_conn);

        let w_method = encode_wide(method);
        let w_path = encode_wide(&path);
        let flags = if is_https { WINHTTP_FLAG_SECURE } else { 0 };
        let h_req = unsafe {
            (api.open_req)(
                conn.1,
                w_method.as_ptr(),
                w_path.as_ptr(),
                null(),
                null(),
                null(),
                flags,
            )
        };
        if h_req.is_null() {
            return Err("WinHttpOpenRequest failed".to_string());
        }
        let req = WinHttpHandle(&api, h_req);

        let payload = body.unwrap_or(&[]);
        let t0 = Instant::now();
        let sent = unsafe {
            (api.send_req)(
                req.1,
                null(),
                0,
                if payload.is_empty() {
                    null()
                } else {
                    payload.as_ptr().cast()
                },
                payload.len() as u32,
                payload.len() as u32,
                0,
            )
        };
        if sent == 0 {
            return Err(format!("WinHttpSendRequest failed for {host}"));
        }
        if unsafe { (api.recv_resp)(req.1, null_mut()) } == 0 {
            return Err(format!("WinHttpReceiveResponse failed for {host}"));
        }
        let ttfb_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let mut status_code = 0u32;
        let mut status_len = size_of::<u32>() as u32;
        unsafe {
            let _ = (api.query_headers)(
                req.1,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                null(),
                (&mut status_code as *mut u32).cast(),
                &mut status_len,
                null_mut(),
            );
        }

        let mut proto_used = 0u32;
        let mut proto_len = size_of::<u32>() as u32;
        let mut http_version = if unsafe {
            (api.query_option)(
                req.1,
                WINHTTP_OPTION_HTTP_PROTOCOL_USED,
                (&mut proto_used as *mut u32).cast(),
                &mut proto_len,
            )
        } != 0
        {
            if (proto_used & 0x2) != 0 {
                Some("h3".to_string())
            } else if (proto_used & 0x1) != 0 {
                Some("h2".to_string())
            } else {
                None
            }
        } else {
            None
        };
        if http_version.is_none() {
            let mut vbuf = [0u16; 32];
            let mut vlen = (vbuf.len() * 2) as u32;
            if unsafe {
                (api.query_headers)(
                    req.1,
                    WINHTTP_QUERY_VERSION,
                    null(),
                    vbuf.as_mut_ptr().cast(),
                    &mut vlen,
                    null_mut(),
                )
            } != 0
            {
                let vstr = String::from_utf16_lossy(&vbuf[..(vlen as usize / 2).min(vbuf.len())])
                    .trim_matches('\0')
                    .trim()
                    .to_string();
                if vstr.contains("2.") {
                    http_version = Some("h2".to_string());
                } else if vstr.contains("3.") {
                    http_version = Some("h3".to_string());
                } else if !vstr.is_empty() {
                    http_version = Some("h1.1".to_string());
                }
            }
        }
        let alpn = http_version.as_deref().map(|v| match v {
            "h1.1" => "http/1.1".to_string(),
            other => other.to_string(),
        });

        let mut tls_version = None;
        let mut cipher_strength_bits = None;
        let mut cert_subject = None;
        let mut cert_issuer = None;
        let mut cert_not_before = None;
        let mut cert_not_after = None;
        let mut cert_days_remaining = None;
        let mut leaf_sha256 = None;
        let mut chain_depth = None;
        let mut root_issuer = None;

        if is_https {
            let mut sec_info: SecPkgContextConnectionInfo = unsafe { zeroed() };
            let mut sec_len = size_of::<SecPkgContextConnectionInfo>() as u32;
            if unsafe {
                (api.query_option)(
                    req.1,
                    WINHTTP_OPTION_SECURITY_INFO,
                    (&mut sec_info as *mut SecPkgContextConnectionInfo).cast(),
                    &mut sec_len,
                )
            } != 0
            {
                tls_version = Some(match sec_info.dw_protocol {
                    p if (p & 0x0000_2000) != 0 => "TLS 1.3".to_string(),
                    p if (p & 0x0000_0800) != 0 => "TLS 1.2".to_string(),
                    p if (p & 0x0000_0200) != 0 => "TLS 1.1".to_string(),
                    p if (p & 0x0000_0080) != 0 => "TLS 1.0".to_string(),
                    other => format!("TLS (0x{other:x})"),
                });
                if sec_info.dw_cipher_strength > 0 {
                    cipher_strength_bits = Some(sec_info.dw_cipher_strength);
                }
            }

            let mut cert_info: WinHttpCertificateInfo = unsafe { zeroed() };
            let mut cert_len = size_of::<WinHttpCertificateInfo>() as u32;
            if unsafe {
                (api.query_option)(
                    req.1,
                    WINHTTP_OPTION_SECURITY_CERTIFICATE_STRUCT,
                    (&mut cert_info as *mut WinHttpCertificateInfo).cast(),
                    &mut cert_len,
                )
            } != 0
            {
                cert_subject = unsafe { read_pwstr(cert_info.lpsz_subject_info) }
                    .map(|s| s.replace("\r\n", ", ").replace('\n', ", "));
                cert_issuer = unsafe { read_pwstr(cert_info.lpsz_issuer_info) }
                    .map(|s| s.replace("\r\n", ", ").replace('\n', ", "));
                if let Some(start_s) = filetime_to_unix_secs(cert_info.ft_start) {
                    cert_not_before = Some(format_unix_date(start_s));
                }
                if let Some(exp_s) = filetime_to_unix_secs(cert_info.ft_expiry) {
                    cert_not_after = Some(format_unix_date(exp_s));
                    let now_s = now_epoch_ms() / 1000;
                    cert_days_remaining = Some((exp_s - now_s) / 86_400);
                }
                if tls_version.is_none() {
                    tls_version = unsafe { read_pwstr(cert_info.lpsz_protocol_name) };
                }
                if cipher_strength_bits.is_none() && cert_info.dw_key_size > 0 {
                    cipher_strength_bits = Some(cert_info.dw_key_size);
                }
                unsafe {
                    for p in [
                        cert_info.lpsz_subject_info,
                        cert_info.lpsz_issuer_info,
                        cert_info.lpsz_protocol_name,
                        cert_info.lpsz_signature_alg_name,
                        cert_info.lpsz_encryption_alg_name,
                    ] {
                        if !p.is_null() {
                            LocalFree(p.cast());
                        }
                    }
                }
            }

            let mut srv_cert_ptr: *const CertContext = null();
            let mut srv_cert_len = size_of::<*const CertContext>() as u32;
            if unsafe {
                (api.query_option)(
                    req.1,
                    WINHTTP_OPTION_SERVER_CERT_CONTEXT,
                    (&mut srv_cert_ptr as *mut *const CertContext).cast(),
                    &mut srv_cert_len,
                )
            } != 0
                && !srv_cert_ptr.is_null()
            {
                let (sha, depth, r_iss) = inspect_cert_chain_and_sha256(srv_cert_ptr);
                leaf_sha256 = sha;
                chain_depth = depth;
                root_issuer = r_iss;
            }
        }

        let mut out_body = Vec::new();
        let mut chunk = [0u8; 8192];
        while out_body.len() < max_read_bytes {
            let mut read = 0u32;
            let to_read = (max_read_bytes - out_body.len()).min(chunk.len()) as u32;
            if unsafe { (api.read_data)(req.1, chunk.as_mut_ptr().cast(), to_read, &mut read) } == 0
                || read == 0
            {
                break;
            }
            out_body.extend_from_slice(&chunk[..read as usize]);
        }

        Ok(SimpleHttpResp {
            status: status_code as u16,
            body: out_body,
            ttfb_ms,
            tls_version,
            cipher_strength_bits,
            cert_subject,
            cert_issuer,
            cert_not_before,
            cert_not_after,
            cert_days_remaining,
            http_version,
            alpn,
            chain_depth,
            root_issuer,
            leaf_sha256,
        })
    }

    pub fn winhttp_stream_download(
        url: &str,
        timeout_ms: u64,
        counter: &AtomicU64,
        stop: &AtomicBool,
        cancel: &AtomicBool,
    ) -> Result<u64, String> {
        let (is_https, host, port, path) = parse_url_parts(url)?;
        let api = WinHttpApi::load()?;

        const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
        const WINHTTP_ACCESS_TYPE_NO_PROXY: u32 = 1;
        const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;

        let access = if host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") || host == "::1" {
            WINHTTP_ACCESS_TYPE_NO_PROXY
        } else {
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        };
        let ua = encode_wide("OmniaSpeedtest/5.0");
        let h_sess = unsafe { (api.open)(ua.as_ptr(), access, null(), null(), 0) };
        if h_sess.is_null() {
            return Err("WinHttpOpen failed".to_string());
        }
        let sess = WinHttpHandle(&api, h_sess);
        let t_i32 = timeout_ms.clamp(250, 30_000) as i32;
        unsafe {
            let _ = (api.set_timeouts)(sess.1, t_i32, t_i32, t_i32, t_i32);
        }

        let w_host = encode_wide(&host);
        let h_conn = unsafe { (api.connect)(sess.1, w_host.as_ptr(), port, 0) };
        if h_conn.is_null() {
            return Err("WinHttpConnect failed".to_string());
        }
        let conn = WinHttpHandle(&api, h_conn);

        let w_method = encode_wide("GET");
        let w_path = encode_wide(&path);
        let flags = if is_https { WINHTTP_FLAG_SECURE } else { 0 };
        let h_req = unsafe {
            (api.open_req)(
                conn.1,
                w_method.as_ptr(),
                w_path.as_ptr(),
                null(),
                null(),
                null(),
                flags,
            )
        };
        if h_req.is_null() {
            return Err("WinHttpOpenRequest failed".to_string());
        }
        let req = WinHttpHandle(&api, h_req);

        if unsafe { (api.send_req)(req.1, null(), 0, null(), 0, 0, 0) } == 0 {
            return Err("WinHttpSendRequest failed".to_string());
        }
        if unsafe { (api.recv_resp)(req.1, null_mut()) } == 0 {
            return Err("WinHttpReceiveResponse failed".to_string());
        }

        let mut total = 0u64;
        let mut buf = [0u8; 65_536];
        while !stop.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
            let mut read = 0u32;
            if unsafe { (api.read_data)(req.1, buf.as_mut_ptr().cast(), buf.len() as u32, &mut read) }
                == 0
                || read == 0
            {
                break;
            }
            let n = u64::from(read);
            total += n;
            counter.fetch_add(n, Ordering::Relaxed);
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn bufferbloat_grading_and_rfc3550_jitter_match_spec() {
        assert_eq!(grade_bufferbloat(3.2), "A+");
        assert_eq!(grade_bufferbloat(18.0), "A");
        assert_eq!(grade_bufferbloat(45.0), "B");
        assert_eq!(grade_bufferbloat(120.0), "C");
        assert_eq!(grade_bufferbloat(310.0), "D");
        assert_eq!(grade_bufferbloat(520.0), "F");

        let p50 = percentile(&[10.0, 20.0, 30.0, 40.0, 100.0], 50.0).unwrap();
        assert_eq!(p50, 30.0);
        let j = rfc3550_jitter_ms(&[10.0, 14.0, 12.0, 16.0]).unwrap();
        assert!(j > 0.0 && j < 4.0);
        assert!(compute_cv_pct(&[100.0, 100.0, 100.0]) == 0.0);
        assert!(compute_cv_pct(&[80.0, 120.0]) > 0.0);
        assert_eq!(compute_sustained_mbps(&[10.0, 50.0, 60.0, 120.0]), 55.0);
    }

    #[test]
    fn proxy_masking_and_vpn_and_mitm_classification_work() {
        assert_eq!(
            mask_proxy_url("http://dummyuser:dummypass@proxy.example.test:8080/pac"),
            "http://dummyuser:***@proxy.example.test:8080/pac"
        );
        assert_eq!(
            mask_proxy_url("socks5://127.0.0.1:10808"),
            "socks5://127.0.0.1:10808"
        );
        assert_eq!(
            classify_vpn_adapter("Tailscale", "Tailscale Tunnel", 53).as_deref(),
            Some("Tailscale")
        );
        assert_eq!(
            classify_vpn_adapter("wg0", "WireGuard Tunnel", 53).as_deref(),
            Some("WireGuard / WinTun")
        );
        assert!(detect_mitm_ca("CN=AdGuard Personal CA").is_some());
        assert!(detect_mitm_ca("CN=Let's Encrypt E5").is_none());
        assert!(is_forbidden_probe_url("https://agy.example.test/v1"));
        assert!(!is_forbidden_probe_url("https://htmustc.id.vn/v1/models"));
        assert_eq!(default_upstream_targets().len(), 9);
        assert!(validate_probe_host("-h").is_err());
        assert!(validate_probe_host("example.com;calc").is_err());
        assert!(validate_probe_host("169.254.169.254").is_err());
        assert!(validate_probe_host("127.0.0.1").is_err());
        assert!(validate_probe_host("api.openai.com").is_ok());
    }

    #[test]
    fn dns_wire_packet_encodes_and_decodes_a_aaaa_ptr_edns0_ad() {
        let q = build_dns_query_ex("example.com", 1, 0x1234, true);
        assert_eq!(q[0], 0x12);
        assert_eq!(q[1], 0x34);
        assert_eq!(u16::from_be_bytes([q[10], q[11]]), 1); // ARCOUNT=1 for EDNS0 OPT

        // Synthetic RFC 1035/6891 response: AD=1, A=198.51.100.7, Additional OPT RR
        let q_no_opt = build_dns_a_query("example.com", 0x1234);
        let mut resp = q_no_opt.clone();
        resp[2] = 0x81; // QR=1, RD=1
        resp[3] = 0xA0; // RA=1, AD=1, RCODE=0
        resp[7] = 1; // ANCOUNT=1
        resp[11] = 1; // ARCOUNT=1
        resp.extend_from_slice(&[0xC0, 0x0C]); // compressed pointer to QNAME
        resp.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // TYPE=A, CLASS=IN
        resp.extend_from_slice(&[0x00, 0x00, 0x00, 0x3C]); // TTL=60
        resp.extend_from_slice(&[0x00, 0x04, 198, 51, 100, 7]); // RDLEN=4 + IP
        resp.push(0); // root
        resp.extend_from_slice(&41u16.to_be_bytes()); // TYPE=OPT
        resp.extend_from_slice(&1232u16.to_be_bytes());
        resp.extend_from_slice(&0u32.to_be_bytes());
        resp.extend_from_slice(&0u16.to_be_bytes());

        assert_eq!(
            parse_dns_a_response(&resp, 0x1234).as_deref(),
            Some("198.51.100.7")
        );
        let parsed = parse_dns_wire_reply(&resp, 0x1234).expect("wire reply");
        assert!(parsed.ad_flag);
        assert!(parsed.edns0_present);
        assert_eq!(parsed.answers_v4, vec!["198.51.100.7"]);

        assert_eq!(
            build_ptr_qname(IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4))),
            "4.3.2.1.in-addr.arpa"
        );
    }

    #[test]
    fn wifi_rf_netstat_pid_doh_and_traceroute_parsers_work_offline() {
        let netsh_wlan = "\
Name                   : Wi-Fi
Description            : Intel(R) Wi-Fi 6 AX200
State                  : connected
SSID                   : OmniaLab5G
BSSID                  : 00:11:22:33:44:55
Radio type             : 802.11ax
Band                   : 5 GHz
Channel                : 149
Receive rate (Mbps)    : 1201
Transmit rate (Mbps)   : 1201
Signal                 : 88%
Rssi                   : -54
Authentication         : WPA3-Personal
Cipher                 : CCMP
";
        let wifi = parse_netsh_wlan_interfaces(netsh_wlan).expect("wifi parse");
        assert_eq!(wifi.ssid, "OmniaLab5G");
        assert_eq!(wifi.bssid.as_deref(), Some("00:11:22:33:44:55"));
        assert_eq!(wifi.rssi_dbm, Some(-54));
        assert_eq!(wifi.band.as_deref(), Some("5 GHz"));
        assert_eq!(wifi.channel, Some(149));
        assert_eq!(wifi.auth_cipher.as_deref(), Some("WPA3-Personal / CCMP"));

        let netstat = "  TCP    127.0.0.1:7897         0.0.0.0:0              LISTENING       4242\n  TCP    127.0.0.1:8888         0.0.0.0:0              LISTENING       9090\n";
        let tasklist = "\"clash-verge.exe\",\"4242\",\"Console\",\"1\",\"32,000 K\"\n\"Fiddler.exe\",\"9090\",\"Console\",\"1\",\"51,000 K\"\n";
        let listeners = parse_netstat_tcp_listeners(netstat, tasklist);
        assert_eq!(listeners.get(&7897), Some(&(4242, "clash-verge.exe".to_string())));
        assert_eq!(
            classify_proxy_process(Some("Fiddler.exe"), "Fiddler"),
            ("Fiddler Debugging Proxy".to_string(), "high".to_string())
        );

        let doh = "DNS-over-HTTPS template : https://1.1.1.1/dns-query\nAuto-upgrade : yes\n";
        let (doh_en, tpls) = parse_netsh_dns_encryption(doh);
        assert!(doh_en);
        assert_eq!(tpls, vec!["https://1.1.1.1/dns-query".to_string()]);

        let tracert = "  1     2 ms     1 ms     2 ms  192.168.1.1\n  2     *        *        *     Request timed out.\n  3   <1 ms     9 ms    10 ms  1.1.1.1\n";
        let hops = parse_traceroute_output(tracert);
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0].ip.as_deref(), Some("192.168.1.1"));
        assert!(hops[1].timed_out);
        assert_eq!(hops[2].ip.as_deref(), Some("1.1.1.1"));
    }

    #[test]
    fn cgnat_split_tunnel_network_type_and_passive_monitor_behave_cleanly() {
        let nic_cgnat = NicAdapterInfo {
            name: "WAN".into(),
            description: "Ethernet".into(),
            kind: "ethernet".into(),
            status: "up".into(),
            ipv4_cidrs: vec!["100.64.12.5/10".into()],
            ipv6_cidrs: vec![],
            ipv6_global: vec![],
            ipv6_link_local: vec![],
            gateways: vec!["100.64.0.1".into()],
            dns_servers: vec!["1.1.1.1".into()],
            dns_suffix: None,
            mtu: 1500,
            link_speed_mbps: Some(1000),
            mac_address: None,
            vpn_tag: None,
            rx_bytes: 100,
            tx_bytes: 200,
            rx_bps: 800,
            tx_bps: 1600,
            if_index: 5,
        };
        let (cls, ev) = classify_local_ip_and_cgnat(std::slice::from_ref(&nic_cgnat), None, None);
        assert_eq!(cls, "RFC6598_CGNAT");
        assert!(ev.is_some());
        assert_eq!(
            classify_network_type(false, false, None, Some("host.example.com")),
            "Residential / ISP"
        );
        assert_eq!(
            classify_network_type(true, false, None, None),
            "VPN / Privacy"
        );

        let mon = PassiveMonitorState::new();
        let snap0 = mon.snapshot();
        assert_eq!(snap0.capacity, 120);
        assert!(!snap0.running);
        assert_eq!(snap0.sample_count, 0);
        assert!(run_bounded_traceroute("-badflag", 4).is_err());
    }

    #[test]
    fn local_identity_and_loopback_speedtest_run_cleanly_offline() {
        let id = inspect_network_identity(&NetDiagOptions {
            probe_public_ip: false,
            timeout_ms: 500,
            force_refresh: false,
        });
        assert_eq!(id.provenance, DataProvenance::Unavailable);
        assert_eq!(id.fingerprint_sha256.len(), 64);

        // Spawn tiny loopback HTTP mock server for deterministic offline speedtest verification.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let server_stop = Arc::new(AtomicBool::new(false));
        let server_stop_c = Arc::clone(&server_stop);
        listener.set_nonblocking(true).expect("nonblocking");
        let srv = std::thread::spawn(move || {
            let payload = vec![0x41u8; 131_072];
            while !server_stop_c.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let body_chunk = payload.clone();
                        std::thread::spawn(move || {
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                            let mut head = [0u8; 2048];
                            let n = stream.read(&mut head).unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            let req_str = String::from_utf8_lossy(&head[..n]);
                            let first = req_str.lines().next().unwrap_or("");
                            if first.starts_with("POST") {
                                let mut drain = [0u8; 8192];
                                let _ = stream.set_read_timeout(Some(Duration::from_millis(40)));
                                while stream.read(&mut drain).unwrap_or(0) > 0 {}
                                let _ = stream.write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                                );
                            } else if first.contains("bytes=0") {
                                let _ = stream.write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                );
                            } else {
                                let hdr = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body_chunk.len()
                                );
                                let _ = stream.write_all(hdr.as_bytes());
                                let _ = stream.write_all(&body_chunk);
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });

        let mut events = 0usize;
        let cfg = SpeedtestConfig {
            profile: "exhaustive".to_string(),
            base_url_override: Some(format!("http://127.0.0.1:{port}")),
            unloaded_samples: 4,
            multi_streams: 2,
            phase_duration_ms: 850,
            stream_mode: "multi".to_string(),
        };
        let res = run_speedtest_streaming("test-run-1", &cfg, Arc::new(AtomicBool::new(false)), |_| {
            events += 1;
        });
        server_stop.store(true, Ordering::Relaxed);
        let _ = srv.join();

        assert_eq!(res.provenance, DataProvenance::Live);
        assert_eq!(res.profile, "exhaustive");
        assert!(!res.cancelled);
        assert!(res.unloaded.samples >= 3);
        assert!(res.download_mbps > 0.0);
        assert!(res.upload_mbps > 0.0);
        assert!(res.sustained_dl_mbps >= 0.0);
        assert!(events >= 5);
        assert!(res.workload_readiness.streaming_4k.score <= 100);
        assert!(res.workload_readiness.gaming.score <= 100);
        assert!(matches!(
            res.bufferbloat_grade.as_str(),
            "A+" | "A" | "B" | "C" | "D" | "F"
        ));
    }

    #[test]
    fn stun_rfc5389_encode_and_decode_xor_mapped_ipv4_and_ipv6() {
        let tx_id: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let req = encode_stun_binding_request(tx_id);
        assert_eq!(req.len(), 20);
        assert_eq!(&req[0..2], &[0x00, 0x01]);
        assert_eq!(&req[4..8], &[0x21, 0x12, 0xA4, 0x42]);
        assert_eq!(&req[8..20], &tx_id);

        let xor_port = (54321u16 ^ 0x2112).to_be_bytes();
        let raw_ip = [203u8, 0, 113, 42];
        let xor_ip = [
            raw_ip[0] ^ 0x21,
            raw_ip[1] ^ 0x12,
            raw_ip[2] ^ 0xA4,
            raw_ip[3] ^ 0x42,
        ];
        let mut resp = Vec::new();
        resp.extend_from_slice(&0x0101u16.to_be_bytes());
        resp.extend_from_slice(&12u16.to_be_bytes());
        resp.extend_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
        resp.extend_from_slice(&tx_id);
        resp.extend_from_slice(&0x0020u16.to_be_bytes());
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.extend_from_slice(&[0x00, 0x01]);
        resp.extend_from_slice(&xor_port);
        resp.extend_from_slice(&xor_ip);

        let decoded = decode_stun_response(&resp, &tx_id).expect("decode stun ipv4");
        assert_eq!(decoded.ip, "203.0.113.42");
        assert_eq!(decoded.port, 54321);
        assert_eq!(decoded.attribute, "XOR-MAPPED-ADDRESS");
        assert!(decode_stun_response(&resp, &[9u8; 12]).is_err());

        let mut mask = [0u8; 16];
        mask[..4].copy_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
        mask[4..16].copy_from_slice(&tx_id);
        let v6_bytes = Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 1).octets();
        let mut v6_resp = Vec::new();
        v6_resp.extend_from_slice(&0x0101u16.to_be_bytes());
        v6_resp.extend_from_slice(&24u16.to_be_bytes());
        v6_resp.extend_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
        v6_resp.extend_from_slice(&tx_id);
        v6_resp.extend_from_slice(&0x0020u16.to_be_bytes());
        v6_resp.extend_from_slice(&20u16.to_be_bytes());
        v6_resp.extend_from_slice(&[0x00, 0x02]);
        v6_resp.extend_from_slice(&(41000u16 ^ 0x2112).to_be_bytes());
        for i in 0..16 {
            v6_resp.push(v6_bytes[i] ^ mask[i]);
        }
        let decoded6 = decode_stun_response(&v6_resp, &tx_id).expect("decode stun ipv6");
        assert_eq!(decoded6.ip, "2001:db8::1");
        assert_eq!(decoded6.port, 41000);
    }

    #[test]
    fn nxdomain_hijack_parser_distinguishes_nxdomain_from_synthesized_a() {
        let tx = 0x5150u16;
        let query = build_dns_a_query("nxprobe.example.invalid", tx);
        let mut nx_resp = query.clone();
        nx_resp[2] = 0x81;
        nx_resp[3] = 0x83;
        let clean = parse_dns_nxdomain_reply(&nx_resp, tx).expect("parse nxdomain");
        assert_eq!(clean.rcode, 3);
        assert!(clean.answers_v4.is_empty());
        assert!(!clean.hijacked);

        let mut hijacked_resp = query;
        hijacked_resp[2] = 0x81;
        hijacked_resp[3] = 0x80;
        hijacked_resp[6] = 0;
        hijacked_resp[7] = 1;
        hijacked_resp.extend_from_slice(&[0xC0, 0x0C]);
        hijacked_resp.extend_from_slice(&1u16.to_be_bytes());
        hijacked_resp.extend_from_slice(&1u16.to_be_bytes());
        hijacked_resp.extend_from_slice(&60u32.to_be_bytes());
        hijacked_resp.extend_from_slice(&4u16.to_be_bytes());
        hijacked_resp.extend_from_slice(&[198, 51, 100, 99]);

        let hij = parse_dns_nxdomain_reply(&hijacked_resp, tx).expect("parse hijack");
        assert_eq!(hij.rcode, 0);
        assert_eq!(hij.answers_v4, vec!["198.51.100.99".to_string()]);
        assert!(hij.hijacked);
    }
}
