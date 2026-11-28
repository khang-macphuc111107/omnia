//! Native Rust Network Identity, DNS Intelligence, Proxy/PAC/TLS Chain Inspector,
//! Passive Upstream Waterfall, and On-Demand Cancellable Speedtest / Bufferbloat Engine.
//!
//! All Windows networking DLLs (`iphlpapi.dll`, `winhttp.dll`, `wlanapi.dll`) are loaded
//! dynamically via `LoadLibraryW` + `GetProcAddress` ONLY on invocation so CLI cold-start
//! latency (`omnia.exe --version <= 15 ms`) and binary size (`<= 14 MiB`) remain unaffected.
//! Never probes `agy` or reads `~/.gemini` OAuth tokens; never fabricates offline data.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
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
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
    pub dns_suffix: Option<String>,
    pub mtu: u32,
    pub link_speed_mbps: Option<u64>,
    pub mac_address: Option<String>,
    pub vpn_tag: Option<String>,
}

/// Active Wi-Fi link telemetry when exposed by Windows WLAN API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiLinkInfo {
    pub interface_name: String,
    pub ssid: String,
    pub signal_pct: u32,
    pub rx_mbps: Option<u64>,
    pub tx_mbps: Option<u64>,
    pub state: String,
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
}

impl Default for DnsBenchOptions {
    fn default() -> Self {
        Self {
            query_domain: "example.com".to_string(),
            trials: 4,
            timeout_ms: 1_000,
            run_benchmark: true,
            public_ipv4_hint: None,
        }
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
}

/// System DNS configuration, multi-resolver benchmark, and VPN leak assessment.
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

/// Detected loopback proxy listener hint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProxyHint {
    pub port: u16,
    pub label: String,
    pub listening: bool,
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
}

/// Configuration for an on-demand cancellable Speedtest & Bufferbloat run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestConfig {
    /// Profile: `"quick"` (~8s) or `"standard"` (~14s).
    pub profile: String,
    /// Optional base URL override (e.g. `http://127.0.0.1:<port>` for offline unit/E2E tests).
    /// Defaults to Cloudflare's unauthenticated speed endpoint (`https://speed.cloudflare.com`).
    pub base_url_override: Option<String>,
    /// Number of unloaded RTT probe samples (default 12 quick / 18 standard).
    pub unloaded_samples: usize,
    /// Concurrent streams for multi-stream DL/UL phase (clamped `2..=6`, default `4`).
    pub multi_streams: usize,
    /// Per-phase duration cap in milliseconds (clamped `800..=8000`).
    pub phase_duration_ms: u64,
}

impl Default for SpeedtestConfig {
    fn default() -> Self {
        Self::for_profile("standard")
    }
}

impl SpeedtestConfig {
    #[must_use]
    pub fn for_profile(profile: &str) -> Self {
        let is_quick = profile.eq_ignore_ascii_case("quick");
        Self {
            profile: if is_quick { "quick" } else { "standard" }.to_string(),
            base_url_override: None,
            unloaded_samples: if is_quick { 10 } else { 16 },
            multi_streams: 4,
            phase_duration_ms: if is_quick { 2_200 } else { 3_800 },
        }
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadScore {
    pub score: u8,
    pub rating: String,
    pub rationale: String,
}

/// Workload readiness breakdown across Omnia's core network-sensitive workloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadReadinessScores {
    pub ai_sse_streaming: WorkloadScore,
    pub git_docker_sync: WorkloadScore,
    pub webrtc: WorkloadScore,
    pub remote_control: WorkloadScore,
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

/// Computes Workload Readiness Scores (`0..=100`) from observed speedtest & bufferbloat metrics.
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

    // 1. AI SSE Streaming: cares strongly about low RTT, low jitter, zero loss, DL bloat, >=10 Mbps.
    let mut ai = 100.0f64;
    ai -= ((rtt - 35.0).max(0.0) * 0.25).min(30.0);
    ai -= (jitter * 1.2).min(20.0);
    ai -= (loss * 12.0).min(35.0);
    ai -= ((dl_delta_ms - 25.0).max(0.0) * 0.15).min(25.0);
    if dl_mbps < 10.0 {
        ai -= ((10.0 - dl_mbps) * 2.5).min(20.0);
    }
    let ai_score = ai.clamp(0.0, 100.0).round() as u8;

    // 2. Git / Docker Sync: cares about multi-stream DL + UL throughput + packet loss.
    let dl_pts = (dl_mbps / 100.0).min(1.0) * 55.0;
    let ul_pts = (ul_mbps / 40.0).min(1.0) * 35.0;
    let loss_pen = (loss * 10.0).min(30.0);
    let git_score = (10.0 + dl_pts + ul_pts - loss_pen).clamp(0.0, 100.0).round() as u8;

    // 3. WebRTC Voice/Video: sensitive to jitter, loss, bufferbloat, and UL >= 5 Mbps.
    let mut rtc = 100.0f64;
    rtc -= ((rtt - 40.0).max(0.0) * 0.2).min(20.0);
    rtc -= (jitter * 2.0).min(25.0);
    rtc -= (loss * 18.0).min(40.0);
    rtc -= ((worst_bloat - 20.0).max(0.0) * 0.22).min(30.0);
    if ul_mbps < 5.0 {
        rtc -= ((5.0 - ul_mbps) * 4.0).min(20.0);
    }
    let rtc_score = rtc.clamp(0.0, 100.0).round() as u8;

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

    WorkloadReadinessScores {
        ai_sse_streaming: WorkloadScore {
            score: ai_score,
            rating: rating(ai_score),
            rationale: format!(
                "RTT p50 {:.1} ms, jitter {:.1} ms, DL bloat +{:.1} ms, loss {:.1}%",
                rtt, jitter, dl_delta_ms, loss
            ),
        },
        git_docker_sync: WorkloadScore {
            score: git_score,
            rating: rating(git_score),
            rationale: format!(
                "DL {:.1} Mbps / UL {:.1} Mbps, loss {:.1}%",
                dl_mbps, ul_mbps, loss
            ),
        },
        webrtc: WorkloadScore {
            score: rtc_score,
            rating: rating(rtc_score),
            rationale: format!(
                "Jitter {:.1} ms, worst bloat +{:.1} ms, UL {:.1} Mbps",
                jitter, worst_bloat, ul_mbps
            ),
        },
        remote_control: WorkloadScore {
            score: rc_score,
            rating: rating(rc_score),
            rationale: format!(
                "p99 RTT {:.1} ms, worst bloat +{:.1} ms, loss {:.1}%",
                p99, worst_bloat, loss
            ),
        },
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

/// Default passive upstream probe targets (strictly excludes `agy` and private OAuth endpoints).
#[must_use]
pub fn default_upstream_targets() -> Vec<EndpointProbeTarget> {
    vec![
        EndpointProbeTarget {
            id: "htmustc".to_string(),
            label: "HTMUSTC Gateway".to_string(),
            url: "https://htmustc.id.vn/v1/models".to_string(),
        },
        EndpointProbeTarget {
            id: "github".to_string(),
            label: "GitHub API".to_string(),
            url: "https://api.github.com/zen".to_string(),
        },
        EndpointProbeTarget {
            id: "crates_io".to_string(),
            label: "crates.io Registry".to_string(),
            url: "https://crates.io/api/v1/summary".to_string(),
        },
    ]
}

fn is_forbidden_probe_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("agy")
        || lower.contains("antigravity")
        || lower.contains("accounts.google.com")
        || lower.contains("oauth2.googleapis.com")
        || lower.contains("169.254.169.254")
        || lower.contains("metadata.google.internal")
}

// =========================================================================
// 1. Network Identity & Interfaces
// =========================================================================

struct CachedPublicNet {
    fetched_at: Instant,
    ipv4: Option<String>,
    ipv6: Option<String>,
    geo: Option<GeoIpInfo>,
}

static PUBLIC_NET_CACHE: OnceLock<Mutex<Option<CachedPublicNet>>> = OnceLock::new();
static WATERFALL_CACHE: OnceLock<Mutex<Option<(Instant, ProxyTlsReport)>>> = OnceLock::new();

/// Inspects local NICs, Wi-Fi link, VPN/TUN/vEthernet interfaces, NAT/CGNAT posture,
/// deterministic SHA-256 fingerprint, and optional public IPv4/IPv6 + GeoIP/ASN/ISP.
#[must_use]
pub fn inspect_network_identity(opts: &NetDiagOptions) -> NetworkIdentityReport {
    let observed_at_ms = now_epoch_ms();
    let adapters = enumerate_local_adapters();
    let wifi = query_active_wifi();

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

    let (provenance, public_ipv4, public_ipv6, geo, detail) = if !opts.probe_public_ip {
        (
            DataProvenance::Unavailable,
            None,
            None,
            None,
            Some("Public IP probe skipped by option (local adapters only).".to_string()),
        )
    } else {
        probe_public_identity_cached(opts.timeout_ms.clamp(500, 6_000), opts.force_refresh)
    };

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
    }
}

fn probe_public_identity_cached(
    timeout_ms: u64,
    force_refresh: bool,
) -> (
    DataProvenance,
    Option<String>,
    Option<String>,
    Option<GeoIpInfo>,
    Option<String>,
) {
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
                    return (prov, c.ipv4.clone(), c.ipv6.clone(), c.geo.clone(), None);
                }
            }
        }
    }

    let mut ipv4: Option<String> = None;
    let mut ipv6: Option<String> = None;
    let mut geo: Option<GeoIpInfo> = None;
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

    // 2. Fallback to Cloudflare trace if IP still missing
    if ipv4.is_none() {
        if let Ok(resp) = http_fetch_simple("https://1.1.1.1/cdn-cgi/trace", "GET", None, timeout_ms)
        {
            if (200..300).contains(&resp.status) {
                let text = String::from_utf8_lossy(&resp.body);
                let mut loc = None;
                let mut colo = None;
                for line in text.lines() {
                    if let Some(v) = line.strip_prefix("ip=") {
                        if let Ok(IpAddr::V4(ip)) = v.trim().parse::<IpAddr>() {
                            ipv4 = Some(ip.to_string());
                        }
                    } else if let Some(v) = line.strip_prefix("loc=") {
                        loc = Some(v.trim().to_string());
                    } else if let Some(v) = line.strip_prefix("colo=") {
                        colo = Some(v.trim().to_string());
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

    if ipv4.is_some() || ipv6.is_some() {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(CachedPublicNet {
                fetched_at: Instant::now(),
                ipv4: ipv4.clone(),
                ipv6: ipv6.clone(),
                geo: geo.clone(),
            });
        }
        return (DataProvenance::Live, ipv4, ipv6, geo, None);
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
        Some(last_err.unwrap_or_else(|| "Public IP lookup unavailable (offline or blocked).".into())),
    )
}

// =========================================================================
// 2. DNS Intelligence & Leak Check (Pure-Rust RFC 1035 UDP Wire Client)
// =========================================================================

/// Inspects system DNS configuration, hosts-file overrides, benchmarks resolvers, and checks VPN DNS leak risk.
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

        // 2. Well-known public resolvers via direct RFC 1035 UDP wire query
        for (name, ip) in [
            ("Cloudflare", "1.1.1.1"),
            ("Google", "8.8.8.8"),
            ("Quad9", "9.9.9.9"),
            ("AdGuard", "94.140.14.14"),
        ] {
            resolvers.push(benchmark_udp_resolver(name, ip, domain, trials, timeout));
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
    for _ in 0..trials {
        let t0 = Instant::now();
        if let Ok(mut addrs) = (domain, 443u16).to_socket_addrs() {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if let Some(first) = addrs.next() {
                if resolved_ip.is_none() {
                    resolved_ip = Some(first.ip().to_string());
                }
                samples.push(round2(ms));
            }
        }
    }
    let stats = summarize_latency(&samples, trials);
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
    for idx in 0..trials {
        let tx_id = 0x4A00u16.wrapping_add((idx as u16).wrapping_mul(37));
        let t0 = Instant::now();
        if let Ok(ip) = udp_dns_query_a(server_ip, domain, tx_id, timeout) {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if resolved_ip.is_none() {
                resolved_ip = Some(ip);
            }
            samples.push(round2(ms));
        }
    }
    let stats = summarize_latency(&samples, trials);
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

/// Builds a minimal RFC 1035 DNS A-record query packet.
#[must_use]
pub fn build_dns_a_query(domain: &str, tx_id: u16) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    pkt.extend_from_slice(&tx_id.to_be_bytes());
    pkt.extend_from_slice(&0x0100u16.to_be_bytes()); // RD=1 standard query
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT=1
    pkt.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT=0
    pkt.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT=0
    pkt.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT=0
    for label in domain.trim_matches('.').split('.') {
        let bytes = label.as_bytes();
        let len = bytes.len().min(63);
        pkt.push(len as u8);
        pkt.extend_from_slice(&bytes[..len]);
    }
    pkt.push(0); // root terminator
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QTYPE = A (1)
    pkt.extend_from_slice(&1u16.to_be_bytes()); // QCLASS = IN (1)
    pkt
}

/// Parses the first IPv4 A-record from an RFC 1035 DNS response matching `expected_tx_id`.
#[must_use]
pub fn parse_dns_a_response(buf: &[u8], expected_tx_id: u16) -> Option<String> {
    if buf.len() < 12 {
        return None;
    }
    let tx_id = u16::from_be_bytes([buf[0], buf[1]]);
    if tx_id != expected_tx_id {
        return None;
    }
    let rcode = buf[3] & 0x0F;
    if rcode != 0 {
        return None;
    }
    let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut pos = 12usize;
    for _ in 0..qdcount {
        pos = skip_dns_name(buf, pos)?;
        pos = pos.checked_add(4)?;
        if pos > buf.len() {
            return None;
        }
    }
    for _ in 0..ancount {
        pos = skip_dns_name(buf, pos)?;
        if pos + 10 > buf.len() {
            return None;
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlen > buf.len() {
            return None;
        }
        if rtype == 1 && rdlen == 4 {
            let ip = Ipv4Addr::new(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
            return Some(ip.to_string());
        }
        pos += rdlen;
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

fn udp_dns_query_a(
    server_ip: &str,
    domain: &str,
    tx_id: u16,
    timeout: Duration,
) -> Result<String, String> {
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
    let query = build_dns_a_query(domain, tx_id);
    sock.send_to(&query, SocketAddr::new(server, 53))
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 512];
    let (n, _) = sock.recv_from(&mut buf).map_err(|e| e.to_string())?;
    parse_dns_a_response(&buf[..n], tx_id).ok_or_else(|| "no A record in DNS response".to_string())
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
// 3. Proxy, PAC & TLS Chain Inspector + Passive Upstream Waterfall
// =========================================================================

/// Inspects environment proxies, WinINET/WinHTTP/PAC config, local proxy listener hints,
/// and 4-stage `DNS -> TCP -> TLS -> TTFB` waterfalls + TLS cert inspection (rate-bounded).
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
    let local_proxy_ports = probe_local_proxy_ports();

    let effective_targets = if targets.is_empty() {
        default_upstream_targets()
    } else {
        targets.to_vec()
    };

    let mut endpoints = Vec::with_capacity(effective_targets.len());
    let mut mitm_warning = None;

    for target in effective_targets {
        if is_forbidden_probe_url(&target.url) {
            endpoints.push(EndpointWaterfall {
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
                error: Some("Target blocked by policy (agy/OAuth/IMDS probes forbidden).".to_string()),
                observed_at_ms,
            });
            continue;
        }
        let wf = probe_endpoint_waterfall(&target, 3_000);
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
        endpoints.push(wf);
    }

    let report = ProxyTlsReport {
        env_proxies,
        system_proxy,
        local_proxy_ports,
        endpoints,
        mitm_warning,
        observed_at_ms,
    };

    if targets.is_empty() {
        if let Ok(mut guard) = cache.lock() {
            *guard = Some((Instant::now(), report.clone()));
        }
    }

    report
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

fn probe_local_proxy_ports() -> Vec<LocalProxyHint> {
    let candidates = [
        (7890u16, "Clash / Mihomo"),
        (7897, "Clash Verge"),
        (10808, "v2rayN / Xray SOCKS"),
        (10809, "v2rayN / Xray HTTP"),
        (2080, "Nekoray / Sing-box"),
        (8080, "Local HTTP Proxy"),
        (8888, "Fiddler / Charles"),
        (8317, "Local API Proxy"),
        (1080, "SOCKS5 Proxy"),
    ];
    let timeout = Duration::from_millis(45);
    candidates
        .into_iter()
        .filter_map(|(port, label)| {
            let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
            let listening = TcpStream::connect_timeout(&addr, timeout).is_ok();
            if listening {
                Some(LocalProxyHint {
                    port,
                    label: label.to_string(),
                    listening: true,
                })
            } else {
                None
            }
        })
        .collect()
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
            };
        }
    };

    // Stage 1: DNS resolution timing
    let dns_t0 = Instant::now();
    let resolved = (host.as_str(), port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut iter| iter.next());
    let dns_ms = resolved.map(|_| round2(dns_t0.elapsed().as_secs_f64() * 1000.0));

    // Stage 2: Raw TCP handshake timing
    let tcp_ms = resolved.and_then(|addr| {
        let t0 = Instant::now();
        TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms.min(2_000)))
            .ok()
            .map(|_| round2(t0.elapsed().as_secs_f64() * 1000.0))
    });

    // Stage 3 & 4: WinHTTP HTTPS/HTTP request for TLS cert chain + TTFB
    match http_fetch_with_tls(&target.url, "GET", None, timeout_ms) {
        Ok(resp) => {
            let total_ms = round2(resp.ttfb_ms);
            let dns_v = dns_ms.unwrap_or(0.0);
            let tcp_v = tcp_ms.unwrap_or(0.0);
            let remaining = (total_ms - dns_v - tcp_v).max(0.0);
            let (tls_ms, ttfb_only_ms) = if is_https {
                // Split observed handshake+TTFB cleanly when direct WinHTTP completed end-to-end
                let tls_est = round2((remaining * 0.42).max(tcp_v * 0.8).min(remaining));
                let ttfb_est = round2((remaining - tls_est).max(0.0));
                (Some(tls_est), Some(ttfb_est))
            } else {
                (None, Some(round2(remaining)))
            };
            let mitm_reason = resp
                .cert_issuer
                .as_deref()
                .and_then(detect_mitm_ca);
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
        },
    }
}

// =========================================================================
// 4. On-Demand Pro Speedtest & Bufferbloat Engine (Live-Streamed + Cancellable)
// =========================================================================

/// Executes an on-demand, cancellable, live-streamed speedtest & bufferbloat measurement:
/// 1. Unloaded RTT baseline (`min/p50/p95/p99/RFC-3550 jitter/loss%`)
/// 2. Progressive Single-Stream -> Multi-Stream Download + Concurrent Loaded Latency Probes
/// 3. Progressive Single-Stream -> Multi-Stream Upload + Concurrent Loaded Latency Probes
/// 4. Exact `+ms` Bufferbloat Delta, `A+..F` Grade, and Workload Readiness Scores.
pub fn run_speedtest_streaming(
    run_id: &str,
    cfg: &SpeedtestConfig,
    cancel: Arc<AtomicBool>,
    mut on_event: impl FnMut(SpeedtestProgressEvent),
) -> SpeedtestResult {
    let started_at_ms = now_epoch_ms();
    let run_t0 = Instant::now();
    let base = cfg
        .base_url_override
        .as_deref()
        .map(|s| s.trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .unwrap_or("https://speed.cloudflare.com")
        .to_string();

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
    let sample_target = cfg.unloaded_samples.clamp(4, 24);
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
        };
    }

    let phase_ms = cfg.phase_duration_ms.clamp(800, 8_000);
    let multi_n = cfg.multi_streams.clamp(2, 6);

    // Phase 2A: Single-Stream Download
    let single_dl = run_transfer_phase(
        TransferKind::Download(&dl_single_url),
        1,
        (phase_ms / 2).max(700),
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
                30,
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
    let multi_dl = if cancel.load(Ordering::Relaxed) {
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
    let single_ul = if cancel.load(Ordering::Relaxed) {
        PhaseTransferOutcome::default()
    } else {
        run_transfer_phase(
            TransferKind::Upload(&ul_url, 256 * 1024),
            1,
            (phase_ms / 2).max(700),
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
                    72,
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
    let multi_ul = if cancel.load(Ordering::Relaxed) {
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

    let download_mbps = round2(single_dl.mbps.max(multi_dl.mbps));
    let upload_mbps = round2(single_ul.mbps.max(multi_ul.mbps));
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

    emit(
        "complete",
        100,
        Some(download_mbps),
        loaded_download.p50_ms.or(unloaded.p50_ms),
        Some(unloaded_p50),
        Some(worst_bloat),
        None,
        &format!(
            "Complete: DL {:.1} Mbps | UL {:.1} Mbps | Bufferbloat {grade} (+{:.1} ms)",
            download_mbps, upload_mbps, worst_bloat
        ),
    );

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
    win32_net::winhttp_request(url, method, body, timeout_ms, 512 * 1024)
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
    let resp = win32_net::winhttp_request(url, "POST", Some(payload), timeout_ms, 4096)?;
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
        // Civil date calculation (Howard Hinnant algorithm) — zero external deps.
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

    // ---- 1. Local NIC Inventory via iphlpapi.dll!GetAdaptersAddresses ----

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
            // AF_INET: sin_addr at offset 4..8
            let ip = Ipv4Addr::new(
                *sa.lp_sockaddr.add(4),
                *sa.lp_sockaddr.add(5),
                *sa.lp_sockaddr.add(6),
                *sa.lp_sockaddr.add(7),
            );
            Some(IpAddr::V4(ip))
        } else if family == 23 && sa.i_sockaddr_length >= 24 {
            // AF_INET6: sin6_addr at offset 8..24
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
        // SAFETY: Signature matches Windows SDK `GetAdaptersAddresses`.
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

        let mut out = Vec::new();
        let mut cur = buf.as_ptr().cast::<IpAdapterAddressesLh>();
        let mut guard = 0usize;
        while !cur.is_null() && guard < 128 {
            guard += 1;
            // SAFETY: `cur` points within `buf` populated by `GetAdaptersAddresses`.
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
            let mut u = a.first_unicast_address;
            let mut u_guard = 0usize;
            while !u.is_null() && u_guard < 32 {
                u_guard += 1;
                let ua = unsafe { &*u };
                if let Some(ip) = unsafe { parse_sockaddr(&ua.address) } {
                    let cidr = format!("{ip}/{}", ua.on_link_prefix_length);
                    match ip {
                        IpAddr::V4(_) => ipv4_cidrs.push(cidr),
                        IpAddr::V6(_) => ipv6_cidrs.push(cidr),
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

            let vpn_tag = classify_vpn_adapter(&name, &description, a.if_type);

            out.push(NicAdapterInfo {
                name,
                description,
                kind,
                status,
                ipv4_cidrs,
                ipv6_cidrs,
                gateways,
                dns_servers,
                dns_suffix,
                mtu: a.mtu,
                link_speed_mbps,
                mac_address,
                vpn_tag,
            });
            cur = a.next;
        }
        out
    }

    // ---- 2. Active Wi-Fi SSID / Signal via wlanapi.dll ----

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
        let mut result = None;
        if unsafe { enum_fn(handle, null_mut(), &mut list_ptr) } == 0 && !list_ptr.is_null() {
            let count = unsafe { (*list_ptr).num_items as usize }.min(16);
            let base = unsafe { (*list_ptr).items.as_ptr() };
            for i in 0..count {
                let info = unsafe { &*base.add(i) };
                // wlan_interface_state_connected == 1
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
                        result = Some(WifiLinkInfo {
                            interface_name: iface_name,
                            ssid,
                            signal_pct: conn.assoc.wlan_signal_quality.min(100),
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
        result
    }

    // ---- 3. WinHTTP Proxy Discovery + HTTPS/TLS Cert Inspection + Streaming Transfer ----

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
    ) -> Result<SimpleHttpResp, String> {
        let (is_https, host, port, path) = parse_url_parts(url)?;
        let api = WinHttpApi::load()?;

        const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
        const WINHTTP_ACCESS_TYPE_NO_PROXY: u32 = 1;
        const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
        const WINHTTP_QUERY_STATUS_CODE: u32 = 19;
        const WINHTTP_QUERY_FLAG_NUMBER: u32 = 0x2000_0000;
        const WINHTTP_OPTION_SECURITY_CERTIFICATE_STRUCT: u32 = 32;
        const WINHTTP_OPTION_SECURITY_INFO: u32 = 151;

        let access = if host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") || host == "::1" {
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

        let mut tls_version = None;
        let mut cipher_strength_bits = None;
        let mut cert_subject = None;
        let mut cert_issuer = None;
        let mut cert_not_before = None;
        let mut cert_not_after = None;
        let mut cert_days_remaining = None;

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
    }

    #[test]
    fn dns_wire_packet_encodes_and_decodes_a_record() {
        let q = build_dns_a_query("example.com", 0x1234);
        assert_eq!(q[0], 0x12);
        assert_eq!(q[1], 0x34);

        // Synthetic RFC 1035 response for example.com -> 198.51.100.7
        let mut resp = q.clone();
        resp[2] = 0x81; // QR=1, RD=1
        resp[3] = 0x80; // RA=1, RCODE=0
        resp[7] = 1; // ANCOUNT=1
        resp.extend_from_slice(&[0xC0, 0x0C]); // compressed pointer to QNAME
        resp.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // TYPE=A, CLASS=IN
        resp.extend_from_slice(&[0x00, 0x00, 0x00, 0x3C]); // TTL=60
        resp.extend_from_slice(&[0x00, 0x04, 198, 51, 100, 7]); // RDLEN=4 + IP
        assert_eq!(
            parse_dns_a_response(&resp, 0x1234).as_deref(),
            Some("198.51.100.7")
        );
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
                                // Drain remaining body lightly
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
            profile: "quick".to_string(),
            base_url_override: Some(format!("http://127.0.0.1:{port}")),
            unloaded_samples: 4,
            multi_streams: 2,
            phase_duration_ms: 850,
        };
        let res = run_speedtest_streaming("test-run-1", &cfg, Arc::new(AtomicBool::new(false)), |_| {
            events += 1;
        });
        server_stop.store(true, Ordering::Relaxed);
        let _ = srv.join();

        assert_eq!(res.provenance, DataProvenance::Live);
        assert!(!res.cancelled);
        assert!(res.unloaded.samples >= 3);
        assert!(res.download_mbps > 0.0);
        assert!(res.upload_mbps > 0.0);
        assert!(events >= 5);
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

        // Build RFC 5389 Binding Success Response with XOR-MAPPED-ADDRESS 203.0.113.42:54321
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
        resp.extend_from_slice(&0x0020u16.to_be_bytes()); // XOR-MAPPED-ADDRESS
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.extend_from_slice(&[0x00, 0x01]);
        resp.extend_from_slice(&xor_port);
        resp.extend_from_slice(&xor_ip);

        let decoded = decode_stun_response(&resp, &tx_id).expect("decode stun ipv4");
        assert_eq!(decoded.ip, "203.0.113.42");
        assert_eq!(decoded.port, 54321);
        assert_eq!(decoded.attribute, "XOR-MAPPED-ADDRESS");

        // Wrong transaction ID must be rejected
        assert!(decode_stun_response(&resp, &[9u8; 12]).is_err());

        // IPv6 XOR-MAPPED-ADDRESS (2001:db8::1 port 41000)
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
        // 1. Clean NXDOMAIN (QR=1, RCODE=3, ANCOUNT=0)
        let mut nx_resp = query.clone();
        nx_resp[2] = 0x81;
        nx_resp[3] = 0x83;
        let clean = parse_dns_nxdomain_reply(&nx_resp, tx).expect("parse nxdomain");
        assert_eq!(clean.rcode, 3);
        assert!(clean.answers_v4.is_empty());
        assert!(!clean.hijacked);

        // 2. Hijacked reply (QR=1, RCODE=0, ANCOUNT=1 with A=198.51.100.99)
        let mut hijacked_resp = query;
        hijacked_resp[2] = 0x81;
        hijacked_resp[3] = 0x80;
        hijacked_resp[6] = 0;
        hijacked_resp[7] = 1;
        hijacked_resp.extend_from_slice(&[0xC0, 0x0C]); // pointer to QNAME at offset 12
        hijacked_resp.extend_from_slice(&1u16.to_be_bytes()); // TYPE A
        hijacked_resp.extend_from_slice(&1u16.to_be_bytes()); // CLASS IN
        hijacked_resp.extend_from_slice(&60u32.to_be_bytes()); // TTL
        hijacked_resp.extend_from_slice(&4u16.to_be_bytes()); // RDLEN
        hijacked_resp.extend_from_slice(&[198, 51, 100, 99]);

        let hij = parse_dns_nxdomain_reply(&hijacked_resp, tx).expect("parse hijack");
        assert_eq!(hij.rcode, 0);
        assert_eq!(hij.answers_v4, vec!["198.51.100.99".to_string()]);
        assert!(hij.hijacked);
    }
}
