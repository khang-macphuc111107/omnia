//! Shared provider destination policy, independent of any desktop framework.
//!
//! [`validated_client`] is the policy-enforcing entry point. DNS answers are
//! checked once and pinned to the resulting client; redirects and environment
//! proxies are disabled. Callers must still restrict requests to the selected
//! origin: a reqwest client is not an origin-scoped capability.

use std::{
    collections::HashSet,
    fmt,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use reqwest::{Client, Url};

pub const MAX_RESOLVED_ADDRESSES: usize = 256;
/// Duplicate DNS records must not turn a bounded result into unbounded work.
pub const MAX_RESOLVED_RECORDS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DestinationErrorClass {
    Dns,
    Transport,
    InvalidInput,
    Policy,
}

/// Static diagnostics never contain endpoint text, DNS answers, or credentials.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DestinationError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    pub class: DestinationErrorClass,
}

impl fmt::Display for DestinationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DestinationError {}

fn error(
    code: &'static str,
    message: &'static str,
    retryable: bool,
    class: DestinationErrorClass,
) -> DestinationError {
    DestinationError {
        code,
        message,
        retryable,
        class,
    }
}

fn invalid(message: &'static str) -> DestinationError {
    error(
        "invalid_input",
        message,
        false,
        DestinationErrorClass::InvalidInput,
    )
}

fn dns_too_large() -> DestinationError {
    error(
        "provider_dns_too_large",
        "The provider hostname returned too many addresses",
        false,
        DestinationErrorClass::Dns,
    )
}

/// Validate the complete bounded DNS result before any network dispatch.
///
/// Local/public mixtures fail even with a local-network grant. Metadata,
/// link-local and other permanently blocked destinations fail before scope
/// checks. At most 256 total records are accepted, including duplicates.
pub fn validate_resolved_addresses(
    scheme: &str,
    addresses: impl IntoIterator<Item = SocketAddr>,
    local_network_grant: bool,
) -> Result<Vec<SocketAddr>, DestinationError> {
    if !matches!(scheme, "http" | "https") {
        return Err(invalid("baseUrl must use HTTP or HTTPS"));
    }
    let mut unique = HashSet::new();
    for (index, address) in addresses.into_iter().enumerate() {
        if index >= MAX_RESOLVED_RECORDS {
            return Err(dns_too_large());
        }
        unique.insert(address);
        if unique.len() > MAX_RESOLVED_ADDRESSES {
            return Err(dns_too_large());
        }
    }
    if unique.is_empty() {
        return Err(error(
            "provider_dns_failed",
            "The provider hostname returned no addresses",
            true,
            DestinationErrorClass::Dns,
        ));
    }
    if unique
        .iter()
        .any(|address| is_always_blocked_destination(address.ip()))
    {
        return Err(error(
            "provider_destination_blocked",
            "Cloud-metadata, link-local, multicast, broadcast, and unspecified destinations are never valid provider endpoints",
            false,
            DestinationErrorClass::Dns,
        ));
    }
    let has_local = unique
        .iter()
        .any(|address| is_private_or_local(address.ip()));
    let has_public = unique
        .iter()
        .any(|address| !is_private_or_local(address.ip()));
    if has_local && has_public {
        return Err(error(
            "provider_dns_mixed_scope",
            "The provider hostname resolved to both public and local addresses",
            false,
            DestinationErrorClass::Dns,
        ));
    }
    if has_local && !local_network_grant {
        return Err(error(
            "local_network_permission_required",
            "The provider resolved to a local or private address without a local-network grant",
            false,
            DestinationErrorClass::Policy,
        ));
    }
    if has_public && scheme != "https" {
        return Err(error(
            "insecure_provider_transport",
            "Internet providers must use HTTPS",
            false,
            DestinationErrorClass::Policy,
        ));
    }
    let mut addresses = unique.into_iter().collect::<Vec<_>>();
    addresses.sort_unstable();
    Ok(addresses)
}

/// Resolve, validate, and pin a provider endpoint. Credentials stay with the host.
///
/// Disabled endpoints are rejected before URL parsing or DNS. The asynchronous
/// DNS resolver may allocate its own result before this module sees it; these
/// caps bound policy collection and work, not the resolver's internal memory.
pub async fn validated_client(
    base_url: &str,
    enabled: bool,
    local_network_grant: bool,
) -> Result<Client, DestinationError> {
    if !enabled {
        return Err(error(
            "provider_disabled",
            "The selected provider is disabled",
            false,
            DestinationErrorClass::Policy,
        ));
    }
    let url = Url::parse(base_url).map_err(|_| invalid("baseUrl is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid("baseUrl must use HTTP or HTTPS"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(invalid("baseUrl must not contain credentials or fragments"));
    }
    let raw_host = url
        .host_str()
        .ok_or_else(|| invalid("baseUrl has no hostname"))?;
    // URL host strings include brackets for IPv6 literals; lookup_host expects
    // the bare literal. Strip only a verified IPv6 literal, never arbitrary
    // bracketed hostname text. The same hostname is passed to DNS pinning.
    let host = match raw_host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    {
        Some(literal) if literal.parse::<std::net::Ipv6Addr>().is_ok() => literal,
        _ => raw_host,
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid("baseUrl has no usable port"))?;
    let addresses = tokio::net::lookup_host((host, port)).await.map_err(|_| {
        error(
            "provider_dns_failed",
            "The provider hostname could not be resolved",
            true,
            DestinationErrorClass::Dns,
        )
    })?;
    let addresses = validate_resolved_addresses(url.scheme(), addresses, local_network_grant)?;
    client_for_resolved_origin(host, &addresses)
}

/// Build the legacy pinned client after the caller validates addresses.
///
/// This lower-level constructor does not grant destination authority and does
/// not validate address scope. Prefer [`validated_client`] for provider profiles.
/// It remains exposed for hosts that have already performed policy validation.
pub fn client_for_resolved_origin(
    host: &str,
    addresses: &[SocketAddr],
) -> Result<Client, DestinationError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(10 * 60))
        .tcp_nodelay(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .user_agent(concat!("Omnia/", env!("CARGO_PKG_VERSION")))
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(|_| {
            error(
                "provider_gateway_unavailable",
                "The provider HTTP gateway could not pin the validated destination",
                false,
                DestinationErrorClass::Transport,
            )
        })
}

/// Classify local/special addresses using Omnia's provider policy.
///
/// This does not grant access: permanently blocked destinations are checked
/// separately and local destinations still require an explicit network grant.
/// IPv4-mapped IPv6 addresses inherit the embedded IPv4 classification.
pub fn is_private_or_local(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_documentation()
                || address.is_multicast()
                || address.is_unspecified()
                || address.octets()[0] == 0
                || address.octets()[0] >= 240
                || matches!(address.octets(), [100, second, _, _] if (64..=127).contains(&second))
                || matches!(address.octets(), [192, 0, 0, _])
                || matches!(address.octets(), [198, second, _, _] if second == 18 || second == 19)
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_multicast()
                || address.is_unspecified()
                || (address.segments()[0] & 0xfe00) == 0xfc00
                || (address.segments()[0] & 0xffc0) == 0xfe80
                || (address.segments()[0] == 0x2001 && address.segments()[1] == 0x0db8)
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| is_private_or_local(IpAddr::V4(address)))
        }
    }
}

fn is_always_blocked_destination(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_unspecified()
                || address.octets()[0] == 0
                || address.octets()[0] >= 240
        }
        IpAddr::V6(address) => {
            address.is_multicast()
                || address.is_unspecified()
                || (address.segments()[0] & 0xffc0) == 0xfe80
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| is_always_blocked_destination(IpAddr::V4(address)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn socket(address: &str) -> SocketAddr {
        address.parse().unwrap()
    }

    #[test]
    fn validation_order_and_static_errors_match_legacy_contract() {
        let invalid = validate_resolved_addresses("ftp", [], true).unwrap_err();
        assert_eq!(invalid.code, "invalid_input");
        assert_eq!(invalid.message, "baseUrl must use HTTP or HTTPS");
        assert_eq!(invalid.class, DestinationErrorClass::InvalidInput);
        let empty = validate_resolved_addresses("https", [], true).unwrap_err();
        assert_eq!(empty.code, "provider_dns_failed");
        assert!(empty.retryable);
        let blocked = validate_resolved_addresses(
            "https",
            [socket("169.254.169.254:443"), socket("8.8.8.8:443")],
            false,
        )
        .unwrap_err();
        assert_eq!(blocked.code, "provider_destination_blocked");
        assert_eq!(blocked.class, DestinationErrorClass::Dns);
        assert!(!blocked.retryable);
    }

    #[test]
    fn policy_requires_grant_and_secure_public_transport() {
        let local = [socket("127.0.0.1:80")];
        assert_eq!(
            validate_resolved_addresses("http", local, false)
                .unwrap_err()
                .code,
            "local_network_permission_required"
        );
        assert!(validate_resolved_addresses("http", local, true).is_ok());
        let public = [socket("8.8.8.8:443")];
        assert_eq!(
            validate_resolved_addresses("http", public, true)
                .unwrap_err()
                .code,
            "insecure_provider_transport"
        );
        assert!(validate_resolved_addresses("https", public, false).is_ok());
        for grant in [false, true] {
            assert_eq!(
                validate_resolved_addresses("https", [local[0], public[0]], grant)
                    .unwrap_err()
                    .code,
                "provider_dns_mixed_scope"
            );
        }
    }

    #[test]
    fn forbidden_ipv4_ipv6_and_mapped_addresses_remain_blocked() {
        for address in [
            "0.0.0.0:80",
            "0.1.2.3:80",
            "169.254.169.254:80",
            "224.0.0.1:80",
            "240.0.0.1:80",
            "255.255.255.255:80",
            "[::]:80",
            "[fe80::1]:80",
            "[ff02::1]:80",
            "[::ffff:169.254.169.254]:80",
            "[::ffff:224.0.0.1]:80",
        ] {
            assert_eq!(
                validate_resolved_addresses("https", [socket(address)], true)
                    .unwrap_err()
                    .code,
                "provider_destination_blocked",
                "{address}"
            );
        }
    }

    #[test]
    fn special_and_mapped_local_addresses_require_permission() {
        for address in [
            "100.64.0.1:80",
            "192.0.0.8:80",
            "192.0.2.1:80",
            "198.18.0.1:80",
            "203.0.113.1:80",
            "[::1]:80",
            "[fc00::1]:80",
            "[2001:db8::1]:80",
            "[::ffff:127.0.0.1]:80",
        ] {
            let addresses = [socket(address)];
            assert_eq!(
                validate_resolved_addresses("https", addresses, false)
                    .unwrap_err()
                    .code,
                "local_network_permission_required",
                "{address}"
            );
            assert!(validate_resolved_addresses("http", addresses, true).is_ok());
        }
        assert!(validate_resolved_addresses(
            "https",
            [socket("[2606:2800:220:1:248:1893:25c8:1946]:443")],
            false,
        )
        .is_ok());
    }

    #[test]
    fn sorts_and_deduplicates_with_exact_unique_limit() {
        let addresses = (1..=MAX_RESOLVED_ADDRESSES / 2)
            .rev()
            .flat_map(|port| [SocketAddr::from(([127, 0, 0, 1], port as u16)); 2]);
        let result = validate_resolved_addresses("http", addresses, true).unwrap();
        assert_eq!(result.len(), MAX_RESOLVED_ADDRESSES / 2);
        assert_eq!(result.first().unwrap().port(), 1);
        assert_eq!(result.last().unwrap().port(), 128);
        let exact = (1..=MAX_RESOLVED_ADDRESSES)
            .map(|port| SocketAddr::from(([127, 0, 0, 1], port as u16)));
        assert_eq!(
            validate_resolved_addresses("http", exact, true)
                .unwrap()
                .len(),
            MAX_RESOLVED_ADDRESSES
        );
        let oversized = (1..=MAX_RESOLVED_ADDRESSES + 1)
            .map(|port| SocketAddr::from(([127, 0, 0, 1], port as u16)));
        let error = validate_resolved_addresses("http", oversized, true).unwrap_err();
        assert_eq!(error.code, "provider_dns_too_large");
        assert!(!error.retryable);
    }

    #[test]
    fn duplicate_records_have_finite_work_and_safe_diagnostics() {
        let endpoint = socket("127.0.0.1:12345");
        assert!(
            validate_resolved_addresses("http", [endpoint; MAX_RESOLVED_RECORDS], true,).is_ok()
        );
        let error =
            validate_resolved_addresses("http", std::iter::repeat(endpoint), true).unwrap_err();
        assert_eq!(error.code, "provider_dns_too_large");
        assert_eq!(error.class, DestinationErrorClass::Dns);
        assert!(!format!("{error:?} {error}").contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn disabled_is_rejected_before_invalid_url_or_dns() {
        for base_url in ["not a URL", "https://no-such-provider.invalid"] {
            let error = validated_client(base_url, false, true).await.unwrap_err();
            assert_eq!(error.code, "provider_disabled");
            assert!(!error.retryable);
            assert!(!format!("{error:?}").contains(base_url));
        }
    }

    #[tokio::test]
    async fn invalid_urls_keep_static_legacy_messages() {
        let error = validated_client("not a URL", true, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert_eq!(error.message, "baseUrl is invalid");
        let error = validated_client("mailto:user@example.com", true, false)
            .await
            .unwrap_err();
        assert_eq!(error.message, "baseUrl must use HTTP or HTTPS");
    }

    #[tokio::test]
    async fn credentials_fragments_and_schemes_fail_before_dns() {
        for base_url in [
            "https://user:secret@no-such-provider.invalid",
            "https://user@no-such-provider.invalid",
            "https://no-such-provider.invalid/#secret",
        ] {
            let error = validated_client(base_url, true, false).await.unwrap_err();
            assert_eq!(error.code, "invalid_input");
            assert_eq!(
                error.message,
                "baseUrl must not contain credentials or fragments"
            );
            assert_eq!(error.class, DestinationErrorClass::InvalidInput);
            assert!(!error.retryable);
            assert!(!format!("{error:?}").contains("secret"));
        }
        let error = validated_client("ftp://no-such-provider.invalid", true, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert_eq!(error.message, "baseUrl must use HTTP or HTTPS");
    }

    #[tokio::test]
    async fn ipv6_literal_grant_and_mapped_metadata_use_ip_lookup() {
        let error = validated_client("http://[::1]:11434", true, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "local_network_permission_required");
        assert!(validated_client("http://[::1]:11434", true, true)
            .await
            .is_ok());
        let error = validated_client("http://[::ffff:169.254.169.254]:80", true, true)
            .await
            .unwrap_err();
        assert_eq!(error.code, "provider_destination_blocked");
    }

    #[tokio::test]
    async fn pinned_client_reaches_isolated_address_without_following_redirect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 1024];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() <= 32 * 1024);
            }
            assert!(String::from_utf8_lossy(&bytes)
                .to_ascii_lowercase()
                .contains("host: provider.invalid"));
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let client = client_for_resolved_origin("provider.invalid", &[destination]).unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            client.get("http://provider.invalid/fixture").send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn validated_loopback_requires_grant() {
        let error = validated_client("http://127.0.0.1:11434", true, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, "local_network_permission_required");
        assert!(validated_client("http://127.0.0.1:11434", true, true)
            .await
            .is_ok());
    }
}
