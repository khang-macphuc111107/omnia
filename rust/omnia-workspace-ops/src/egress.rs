//! Fail-closed outbound URL, IP, DNS-rebinding, and child-process network egress policy.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::process::Command;

/// Network isolation posture enforced on sandboxed child processes and HTTP/WS tools.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressMode {
    /// Block all outbound network destinations (`127.0.0.1` included).
    DenyAll,
    /// Allow only verified loopback destinations (`127.0.0.1`, `[::1]`, `localhost`) on allowed ports.
    LoopbackOnly,
    /// Allow public HTTPS/HTTP hosts matching allowlist rules while rejecting private/IMDS/SSRF targets.
    #[default]
    PublicOnly,
    /// Allow public hosts AND explicit loopback ports (for local dev servers), while blocking RFC-1918/IMDS.
    PublicAndLoopback,
}

/// Configurable fail-closed outbound network policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressPolicy {
    pub mode: EgressMode,
    /// Allowed URL schemes (lowercased, e.g. `["https", "http"]`).
    pub allowed_schemes: Vec<String>,
    /// Optional domain allowlist (exact domain or `*.suffix`). Empty = allow any non-blocked host.
    pub allowed_hosts: BTreeSet<String>,
    /// Explicit domain denylist (exact domain or `*.suffix`). Always takes precedence.
    pub blocked_hosts: BTreeSet<String>,
    /// Optional port allowlist. Empty = allow standard scheme ports (or any port for loopback when allowed).
    pub allowed_ports: BTreeSet<u16>,
    /// Require DNS resolution verification before connecting so public domains resolving to private IPs fail closed.
    pub verify_dns_non_private: bool,
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            mode: EgressMode::PublicOnly,
            allowed_schemes: vec!["https".into(), "http".into()],
            allowed_hosts: BTreeSet::new(),
            blocked_hosts: BTreeSet::new(),
            allowed_ports: BTreeSet::new(),
            verify_dns_non_private: true,
        }
    }
}

impl EgressPolicy {
    /// Strict loopback-only policy (for local MCP / CDP / Studio endpoints).
    #[must_use]
    pub fn loopback_only(schemes: &[&str]) -> Self {
        Self {
            mode: EgressMode::LoopbackOnly,
            allowed_schemes: schemes.iter().map(|s| s.to_ascii_lowercase()).collect(),
            allowed_hosts: BTreeSet::new(),
            blocked_hosts: BTreeSet::new(),
            allowed_ports: BTreeSet::new(),
            verify_dns_non_private: false,
        }
    }

    /// Public web fetch/search policy rejecting all private/loopback/IMDS/internal hosts.
    #[must_use]
    pub fn public_web() -> Self {
        Self::default()
    }

    /// Deny every outbound URL/host and inject dead-end proxy env vars into child commands.
    #[must_use]
    pub fn deny_all() -> Self {
        Self {
            mode: EgressMode::DenyAll,
            allowed_schemes: Vec::new(),
            allowed_hosts: BTreeSet::new(),
            blocked_hosts: BTreeSet::new(),
            allowed_ports: BTreeSet::new(),
            verify_dns_non_private: true,
        }
    }
}

/// Validated URL components returned by [`validate_egress_url`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedEgressTarget {
    pub normalized_url: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub is_loopback: bool,
}

/// Errors emitted when an outbound target or resolved address violates [`EgressPolicy`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EgressError {
    #[error("network egress disabled by policy")]
    Disabled,
    #[error("invalid URL `{url}`: {reason}")]
    InvalidUrl { url: String, reason: String },
    #[error("URL scheme `{0}` is not allowed by egress policy")]
    DisallowedScheme(String),
    #[error("URL must not contain embedded userinfo credentials")]
    EmbeddedCredentialsRejected,
    #[error("host `{host}` is blocked by SSRF/egress policy: {reason}")]
    BlockedHost { host: String, reason: String },
    #[error("port {0} is not allowed by egress policy")]
    BlockedPort(u16),
    #[error("DNS resolution for `{host}:{port}` yielded blocked IP `{ip}`: {reason}")]
    BlockedResolvedIp {
        host: String,
        port: u16,
        ip: String,
        reason: String,
    },
    #[error("DNS resolution failed for `{host}:{port}`: {reason}")]
    DnsResolutionFailed {
        host: String,
        port: u16,
        reason: String,
    },
}

/// Validates URL syntax, scheme, absence of embedded credentials, port, host rules, and IP class.
pub fn validate_egress_url(
    raw_url: &str,
    policy: &EgressPolicy,
) -> Result<ValidatedEgressTarget, EgressError> {
    if policy.mode == EgressMode::DenyAll {
        return Err(EgressError::Disabled);
    }

    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(EgressError::InvalidUrl {
            url: String::new(),
            reason: "empty URL".into(),
        });
    }
    if trimmed.chars().any(char::is_control) {
        return Err(EgressError::InvalidUrl {
            url: "<control-chars>".into(),
            reason: "control characters not permitted in URL".into(),
        });
    }

    let Some((raw_scheme, rest)) = trimmed.split_once("://") else {
        return Err(EgressError::InvalidUrl {
            url: trimmed.to_owned(),
            reason: "missing scheme://".into(),
        });
    };
    let scheme = raw_scheme.to_ascii_lowercase();
    if !policy.allowed_schemes.iter().any(|s| s == &scheme) {
        return Err(EgressError::DisallowedScheme(scheme));
    }

    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return Err(EgressError::InvalidUrl {
            url: trimmed.to_owned(),
            reason: "missing URL authority/host".into(),
        });
    }
    if authority.contains('@') {
        return Err(EgressError::EmbeddedCredentialsRejected);
    }

    let (host, explicit_port) = parse_authority_host_port(authority, trimmed)?;
    let port = explicit_port.unwrap_or(match scheme.as_str() {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        _ => {
            return Err(EgressError::InvalidUrl {
                url: trimmed.to_owned(),
                reason: "explicit port required for custom scheme".into(),
            })
        }
    });
    if port == 0 {
        return Err(EgressError::BlockedPort(0));
    }
    if !policy.allowed_ports.is_empty() && !policy.allowed_ports.contains(&port) {
        return Err(EgressError::BlockedPort(port));
    }

    let host_lower = host.trim_end_matches('.').to_ascii_lowercase();
    if host_lower.is_empty() {
        return Err(EgressError::InvalidUrl {
            url: trimmed.to_owned(),
            reason: "empty host".into(),
        });
    }

    let is_loopback = classify_and_check_host(&host_lower, policy)?;

    Ok(ValidatedEgressTarget {
        normalized_url: trimmed.to_owned(),
        scheme,
        host: host_lower,
        port,
        is_loopback,
    })
}

/// Validates a URL AND resolves DNS (when not an IP literal) to block DNS rebinding into private/IMDS networks.
pub fn validate_egress_url_with_dns(
    raw_url: &str,
    policy: &EgressPolicy,
) -> Result<(ValidatedEgressTarget, Vec<SocketAddr>), EgressError> {
    let target = validate_egress_url(raw_url, policy)?;
    if let Ok(ip) = target.host.parse::<IpAddr>() {
        return Ok((target.clone(), vec![SocketAddr::new(ip, target.port)]));
    }
    if !policy.verify_dns_non_private {
        return Ok((target, Vec::new()));
    }

    let addrs: Vec<SocketAddr> = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .map_err(|err| EgressError::DnsResolutionFailed {
            host: target.host.clone(),
            port: target.port,
            reason: err.to_string(),
        })?
        .collect();
    if addrs.is_empty() {
        return Err(EgressError::DnsResolutionFailed {
            host: target.host.clone(),
            port: target.port,
            reason: "zero DNS records returned".into(),
        });
    }

    for addr in &addrs {
        if let Some(reason) = blocked_ip_reason(addr.ip(), policy.mode) {
            return Err(EgressError::BlockedResolvedIp {
                host: target.host.clone(),
                port: target.port,
                ip: addr.ip().to_string(),
                reason: reason.to_owned(),
            });
        }
    }

    Ok((target, addrs))
}

/// Applies outbound proxy/egress restrictions onto a child [`Command`] environment.
pub fn apply_egress_env_to_command(cmd: &mut Command, policy: &EgressPolicy) {
    match policy.mode {
        EgressMode::DenyAll => {
            // Blackhole HTTP/HTTPS proxy environment so well-behaved runtimes fail closed offline.
            cmd.env("HTTP_PROXY", "http://127.0.0.1:0")
                .env("HTTPS_PROXY", "http://127.0.0.1:0")
                .env("ALL_PROXY", "socks5h://127.0.0.1:0")
                .env("http_proxy", "http://127.0.0.1:0")
                .env("https_proxy", "http://127.0.0.1:0")
                .env("all_proxy", "socks5h://127.0.0.1:0")
                .env("NO_PROXY", "")
                .env("no_proxy", "")
                .env("OMNIA_EGRESS_POLICY", "deny_all");
        }
        EgressMode::LoopbackOnly => {
            cmd.env("HTTP_PROXY", "http://127.0.0.1:0")
                .env("HTTPS_PROXY", "http://127.0.0.1:0")
                .env("NO_PROXY", "127.0.0.1,localhost,::1")
                .env("no_proxy", "127.0.0.1,localhost,::1")
                .env("OMNIA_EGRESS_POLICY", "loopback_only");
        }
        EgressMode::PublicOnly => {
            cmd.env("OMNIA_EGRESS_POLICY", "public_only");
        }
        EgressMode::PublicAndLoopback => {
            cmd.env("OMNIA_EGRESS_POLICY", "public_and_loopback");
        }
    }
}

fn parse_authority_host_port(
    authority: &str,
    raw_url: &str,
) -> Result<(String, Option<u16>), EgressError> {
    if let Some(after_open) = authority.strip_prefix('[') {
        let Some((ip_part, tail)) = after_open.split_once(']') else {
            return Err(EgressError::InvalidUrl {
                url: raw_url.to_owned(),
                reason: "unclosed IPv6 bracket".into(),
            });
        };
        if ip_part.is_empty() || ip_part.parse::<Ipv6Addr>().is_err() {
            return Err(EgressError::InvalidUrl {
                url: raw_url.to_owned(),
                reason: "invalid IPv6 host literal".into(),
            });
        }
        if tail.is_empty() {
            return Ok((ip_part.to_owned(), None));
        }
        let Some(port_str) = tail.strip_prefix(':') else {
            return Err(EgressError::InvalidUrl {
                url: raw_url.to_owned(),
                reason: "unexpected trailing authority characters after IPv6 literal".into(),
            });
        };
        let port = port_str.parse::<u16>().map_err(|_| EgressError::InvalidUrl {
            url: raw_url.to_owned(),
            reason: format!("invalid port `{port_str}`"),
        })?;
        return Ok((ip_part.to_owned(), Some(port)));
    }

    if let Some((host_part, port_str)) = authority.rsplit_once(':') {
        if host_part.contains(':') {
            return Err(EgressError::InvalidUrl {
                url: raw_url.to_owned(),
                reason: "unbracketed IPv6 literal".into(),
            });
        }
        let port = port_str.parse::<u16>().map_err(|_| EgressError::InvalidUrl {
            url: raw_url.to_owned(),
            reason: format!("invalid port `{port_str}`"),
        })?;
        return Ok((host_part.to_owned(), Some(port)));
    }

    Ok((authority.to_owned(), None))
}

fn classify_and_check_host(host: &str, policy: &EgressPolicy) -> Result<bool, EgressError> {
    if policy.blocked_hosts.iter().any(|p| host_matches_pattern(host, p)) {
        return Err(EgressError::BlockedHost {
            host: host.to_owned(),
            reason: "matched explicit denylist".into(),
        });
    }

    if !policy.allowed_hosts.is_empty()
        && !policy.allowed_hosts.iter().any(|p| host_matches_pattern(host, p))
    {
        return Err(EgressError::BlockedHost {
            host: host.to_owned(),
            reason: "not in allowed_hosts".into(),
        });
    }

    let is_localhost_name = host == "localhost" || host.ends_with(".localhost");
    if let Ok(ip) = host.parse::<IpAddr>() {
        if let Some(reason) = blocked_ip_reason(ip, policy.mode) {
            return Err(EgressError::BlockedHost {
                host: host.to_owned(),
                reason: reason.to_owned(),
            });
        }
        return Ok(is_ip_loopback(ip));
    }

    if is_localhost_name {
        return match policy.mode {
            EgressMode::LoopbackOnly | EgressMode::PublicAndLoopback => Ok(true),
            EgressMode::PublicOnly | EgressMode::DenyAll => Err(EgressError::BlockedHost {
                host: host.to_owned(),
                reason: "localhost disallowed under public-only egress".into(),
            }),
        };
    }

    if policy.mode == EgressMode::LoopbackOnly {
        return Err(EgressError::BlockedHost {
            host: host.to_owned(),
            reason: "external hostname disallowed under loopback_only".into(),
        });
    }

    // Reject single-label internal hostnames, .local, .internal, cloud metadata domains.
    if !host.contains('.')
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".localdomain")
        || host == "metadata.google.internal"
    {
        return Err(EgressError::BlockedHost {
            host: host.to_owned(),
            reason: "internal or unqualified hostname blocked".into(),
        });
    }

    Ok(false)
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    let pat = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if pat.is_empty() {
        return false;
    }
    if let Some(suffix) = pat.strip_prefix("*.") {
        return host == suffix || host.ends_with(&format!(".{suffix}"));
    }
    host == pat
}

#[must_use]
pub fn is_ip_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

/// Returns `Some(reason)` if `ip` must be blocked under `mode`.
#[must_use]
pub fn blocked_ip_reason(ip: IpAddr, mode: EgressMode) -> Option<&'static str> {
    match mode {
        EgressMode::DenyAll => return Some("deny_all policy"),
        EgressMode::LoopbackOnly => {
            return (!is_ip_loopback(ip)).then_some("non-loopback IP disallowed under loopback_only");
        }
        EgressMode::PublicOnly | EgressMode::PublicAndLoopback => {}
    }

    match ip {
        IpAddr::V4(v4) => blocked_ipv4_reason(v4, mode),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return blocked_ipv4_reason(mapped, mode);
            }
            if v6.is_loopback() {
                return (mode == EgressMode::PublicOnly)
                    .then_some("loopback IPv6 blocked under public_only");
            }
            let segs = v6.segments();
            if v6.is_unspecified()
                || v6.is_multicast()
                || (segs[0] & 0xfe00) == 0xfc00
                || (segs[0] & 0xffc0) == 0xfe80
            {
                return Some("private/link-local/unspecified IPv6 blocked");
            }
            None
        }
    }
}

fn blocked_ipv4_reason(v4: Ipv4Addr, mode: EgressMode) -> Option<&'static str> {
    if v4.is_loopback() {
        return (mode == EgressMode::PublicOnly)
            .then_some("loopback IPv4 blocked under public_only");
    }
    let [a, b, _, _] = v4.octets();
    if v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || a >= 224
    {
        return Some("private/CGNAT/link-local/reserved IPv4 blocked");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_web_blocks_ssrf_imds_and_loopback() {
        let policy = EgressPolicy::public_web();
        for bad in [
            "http://127.0.0.1:8080/secret",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/internal",
            "http://[::ffff:127.0.0.1]/",
            "http://[::1]:3000/",
            "http://localhost:9222/json/version",
            "http://metadata.google.internal/computeMetadata/v1/",
            "file:///C:/Windows/win.ini",
            "https://user:dummy_pw@example.com/resource",
        ] {
            assert!(
                validate_egress_url(bad, &policy).is_err(),
                "expected SSRF block for {bad}"
            );
        }
        assert!(validate_egress_url("https://example.com/docs?q=1", &policy).is_ok());
    }

    #[test]
    fn loopback_only_allows_only_loopback() {
        let policy = EgressPolicy::loopback_only(&["http", "ws"]);
        assert!(validate_egress_url("http://127.0.0.1:9222/json/version", &policy).is_ok());
        assert!(validate_egress_url("ws://[::1]:9222/devtools/browser/abc", &policy).is_ok());
        assert!(validate_egress_url("https://example.com/", &policy).is_err());
        assert!(validate_egress_url("http://192.168.1.10:9222/", &policy).is_err());
    }
}
