//! Replayable request description (captured browser requests keep their auth context).

use crate::error::{DownloadError, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE, REFERER, USER_AGENT};
use reqwest::{Client, Method, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::time::Duration;

/// Persistence intentionally removes URL userinfo, query signatures, and fragments.
/// Restore requires browser reauthentication via DownloadEngine::reauthorize.
pub fn serialize_public_url<S: serde::Serializer>(
    value: &str,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    let clean = url::Url::parse(value)
        .map(|mut u| {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        })
        .unwrap_or_default();
    s.serialize_str(&clean)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || v.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v) => {
            // Only global unicast; exclude transition/mapped, documentation and local ranges.
            let s = v.segments();
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2001
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    #[serde(serialize_with = "serialize_public_url")]
    pub url: String,
    /// Explicitly local fixture policy; never deserializable from browser input.
    #[cfg(test)]
    #[serde(skip)]
    pub(crate) test_loopback: bool,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default, skip_serializing)]
    pub headers: Vec<(String, String)>,
    /// Value for the `Cookie` header.
    #[serde(default, skip_serializing)]
    pub cookies: Option<String>,
    #[serde(default, skip_serializing)]
    pub referer: Option<String>,
    #[serde(default, skip_serializing)]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing)]
    pub body: Option<Vec<u8>>,
}

fn default_method() -> String {
    "GET".into()
}

impl RequestSpec {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            #[cfg(test)]
            test_loopback: false,
            method: default_method(),
            headers: Vec::new(),
            cookies: None,
            referer: None,
            user_agent: None,
            body: None,
        }
    }

    /// Synchronous pre-flight of the destination policy enforced by [`send`](Self::send):
    /// HTTP(S) only, no userinfo, and no loopback/private literal IPs or `localhost` names.
    /// Hostnames that resolve to non-public addresses are still rejected at send time.
    pub fn validate(&self) -> Result<()> {
        let u = url::Url::parse(&self.url)
            .map_err(|_| DownloadError::InvalidRequest("invalid URL".into()))?;
        if !matches!(u.scheme(), "http" | "https") {
            return Err(DownloadError::InvalidRequest(format!(
                "unsupported URL scheme {:?}; only http and https are allowed",
                u.scheme()
            )));
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err(DownloadError::InvalidRequest(
                "URLs with embedded credentials are not allowed".into(),
            ));
        }
        let blocked = || {
            DownloadError::InvalidRequest(
                "downloads to loopback/private addresses are not allowed".into(),
            )
        };
        let allowed = |ip: IpAddr| {
            #[cfg(test)]
            if self.test_loopback && ip.is_loopback() {
                return true;
            }
            public_ip(ip)
        };
        match u.host() {
            None => Err(DownloadError::InvalidRequest("URL needs a host".into())),
            Some(url::Host::Ipv4(ip)) if !allowed(ip.into()) => Err(blocked()),
            Some(url::Host::Ipv6(ip)) if !allowed(ip.into()) => Err(blocked()),
            Some(url::Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_ascii_lowercase();
                if d == "localhost" || d.ends_with(".localhost") {
                    Err(blocked())
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }

    pub fn is_get(&self) -> bool {
        self.method.eq_ignore_ascii_case("GET")
    }

    /// Same auth context (headers, cookies, referer, UA) but a different URL; always a body-less GET.
    /// Used for playlist-relative resources such as segments and keys.
    pub fn derive(&self, url: impl Into<String>) -> Self {
        let url = url.into();
        let same_origin = url::Url::parse(&self.url)
            .ok()
            .zip(url::Url::parse(&url).ok())
            .is_some_and(|(a, b)| a.origin() == b.origin());
        let mut derived = Self {
            url,
            method: default_method(),
            body: None,
            ..self.clone()
        };
        if !same_origin {
            // Custom headers can contain arbitrary secrets: do not use a blacklist.
            derived.headers.clear();
            derived.cookies = None;
            derived.referer = None;
        }
        derived
    }

    /// Secure transport: validates every redirect, pins resolved public addresses (no DNS
    /// rebinding window), disables proxy/environment routing, and strips cross-origin auth.
    /// The supplied client is retained for API compatibility, not trusted for redirects/DNS.
    pub async fn send(&self, _client: &Client, range: Option<&str>) -> Result<reqwest::Response> {
        let mut spec = self.clone();
        for hop in 0..=10 {
            let u = url::Url::parse(&spec.url)?;
            if !matches!(u.scheme(), "http" | "https")
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err(DownloadError::InvalidRequest(
                    "only HTTP(S) URLs without userinfo are allowed".into(),
                ));
            }
            let host = u
                .host_str()
                .ok_or_else(|| DownloadError::InvalidRequest("URL needs a host".into()))?;
            let port = u.port_or_known_default().unwrap_or(443);
            let addrs: Vec<_> = match u.host() {
                Some(url::Host::Ipv4(ip)) => vec![std::net::SocketAddr::new(ip.into(), port)],
                Some(url::Host::Ipv6(ip)) => vec![std::net::SocketAddr::new(ip.into(), port)],
                _ => tokio::net::lookup_host((host, port)).await?.collect(),
            };
            let allowed = |ip: IpAddr| {
                #[cfg(test)]
                if spec.test_loopback && ip.is_loopback() {
                    return true;
                }
                public_ip(ip)
            };
            if addrs.is_empty() || addrs.iter().any(|a| !allowed(a.ip())) {
                return Err(DownloadError::InvalidRequest(
                    "destination is not a public network address".into(),
                ));
            }
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(host, &addrs)
                .connect_timeout(Duration::from_secs(20))
                .read_timeout(Duration::from_secs(45))
                .build()?;
            let resp = spec.build(&client, range)?.send().await?;
            if !resp.status().is_redirection() {
                return Ok(resp);
            }
            if hop == 10 {
                break;
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| DownloadError::InvalidRequest("redirect missing Location".into()))?;
            let target = u.join(location)?;
            if u.scheme() == "https" && target.scheme() != "https" {
                return Err(DownloadError::InvalidRequest(
                    "HTTPS downgrade refused".into(),
                ));
            }
            let status = resp.status().as_u16();
            let old = spec.clone();
            spec = old.derive(target.to_string());
            if matches!(status, 307 | 308) || ((status == 301 || status == 302) && old.is_get()) {
                spec.method = old.method;
                spec.body = old.body;
            } else if old.method == "HEAD" {
                spec.method = old.method;
            }
        }
        Err(DownloadError::InvalidRequest("too many redirects".into()))
    }

    /// Build headers only. Network users must use `send` to enforce destination policy.
    pub fn build(&self, client: &Client, range: Option<&str>) -> Result<RequestBuilder> {
        let method = Method::from_bytes(self.method.to_ascii_uppercase().as_bytes())
            .map_err(|e| DownloadError::InvalidRequest(format!("bad method: {e}")))?;
        let mut map = HeaderMap::new();
        for (k, v) in &self.headers {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| DownloadError::InvalidRequest(format!("bad header name {k}: {e}")))?;
            // Framing headers are owned by the HTTP client; Range is controlled by the downloader.
            if matches!(
                name.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "range"
                    | "if-range"
                    | "transfer-encoding"
            ) {
                continue;
            }
            let value = HeaderValue::from_str(v).map_err(|e| {
                DownloadError::InvalidRequest(format!("bad header value for {k}: {e}"))
            })?;
            map.append(name, value);
        }
        let hv = |s: &str| {
            HeaderValue::from_str(s).map_err(|e| DownloadError::InvalidRequest(e.to_string()))
        };
        if let Some(c) = &self.cookies {
            map.insert(COOKIE, hv(c)?);
        }
        if let Some(r) = &self.referer {
            map.insert(REFERER, hv(r)?);
        }
        if let Some(u) = &self.user_agent {
            map.insert(USER_AGENT, hv(u)?);
        }
        if let Some(r) = range {
            map.insert(reqwest::header::RANGE, hv(r)?);
        }
        let mut rb = client.request(method, &self.url).headers(map);
        if let Some(b) = &self.body {
            rb = rb.body(b.clone());
        }
        Ok(rb)
    }
}

/// HTTP client used by all downloaders (no transparent decompression so byte ranges stay exact).
pub fn build_client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(45))
        .pool_max_idle_per_host(32)
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_camel_case_defaults() {
        let spec: RequestSpec =
            serde_json::from_str(r#"{"url":"http://x/y","userAgent":"UA"}"#).unwrap();
        assert_eq!(spec.method, "GET");
        assert_eq!(spec.user_agent.as_deref(), Some("UA"));
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(json["method"], "GET");
        assert_eq!(json["url"], "http://x/y");
        assert!(json.get("userAgent").is_none());
    }

    #[test]
    fn persisted_requests_do_not_retain_auth_context() {
        let mut spec =
            RequestSpec::get("https://user:password@example.com/file?token=secret#fragment");
        spec.headers
            .push(("Authorization".into(), "Bearer private".into()));
        spec.cookies = Some("session=private".into());
        spec.referer = Some("https://example.com/?token=private".into());
        spec.user_agent = Some("private-agent".into());
        spec.body = Some(b"private-body".to_vec());
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(json["url"], "https://example.com/file");
        for field in ["headers", "cookies", "referer", "userAgent", "body"] {
            assert!(
                json.get(field).is_none(),
                "persisted sensitive field: {field}"
            );
        }
        let restored: RequestSpec = serde_json::from_value(json).unwrap();
        assert!(restored.headers.is_empty());
        assert!(restored.cookies.is_none());
        assert!(restored.body.is_none());
    }

    #[test]
    fn derived_resources_only_inherit_credentials_on_the_same_origin() {
        let mut spec = RequestSpec::get("https://example.com/master.m3u8");
        spec.headers
            .push(("Authorization".into(), "Bearer private".into()));
        spec.cookies = Some("session=private".into());
        spec.referer = Some(spec.url.clone());
        spec.body = Some(b"private-body".to_vec());
        let same = spec.derive("https://example.com/segment.ts");
        assert_eq!(same.headers, spec.headers);
        assert_eq!(same.cookies, spec.cookies);
        assert!(same.body.is_none());
        for url in [
            "https://other.example/segment.ts",
            "http://example.com/segment.ts",
            "https://example.com:8443/segment.ts",
        ] {
            let other = spec.derive(url);
            assert!(other.headers.is_empty());
            assert!(other.cookies.is_none());
            assert!(other.referer.is_none());
            assert!(other.body.is_none());
        }
    }

    #[test]
    fn validate_rejects_blocked_destinations_and_schemes() {
        for url in [
            "http://127.0.0.1/x",
            "http://localhost:8080/x",
            "http://10.0.0.5/x",
            "http://[::1]/x",
            "http://a.localhost/x",
        ] {
            let err = RequestSpec::get(url).validate().unwrap_err();
            assert!(
                matches!(err, DownloadError::InvalidRequest(m) if m.contains("loopback/private")),
                "{url}"
            );
        }
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "https://u:p@example.com/x",
            "not a url",
        ] {
            assert!(
                matches!(
                    RequestSpec::get(url).validate(),
                    Err(DownloadError::InvalidRequest(_))
                ),
                "{url}"
            );
        }
        assert!(RequestSpec::get("https://example.com/video.m3u8")
            .validate()
            .is_ok());
        assert!(RequestSpec::get("http://8.8.8.8/x").validate().is_ok());
    }

    #[tokio::test]
    async fn send_rejects_loopback_without_explicit_fixture_opt_in() {
        let spec = RequestSpec::get("http://127.0.0.1:9/fixture");
        let err = spec.send(&build_client().unwrap(), None).await.unwrap_err();
        assert!(
            matches!(err, DownloadError::InvalidRequest(message) if message.contains("public network address"))
        );
    }

    #[test]
    fn network_request_building_is_confined_to_secure_transport() {
        // Scan every module, not just today's known callers, so a new direct-build
        // send cannot silently bypass destination validation and redirect handling.
        fn check(dir: &std::path::Path) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    check(&path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && path.file_name().unwrap() != "request.rs"
                {
                    let source = std::fs::read_to_string(&path).unwrap();
                    let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
                    assert!(
                        !compact.contains(".build("),
                        "request builder outside secure transport: {}",
                        path.display()
                    );
                    assert!(
                        !compact.contains(".execute("),
                        "direct client dispatch: {}",
                        path.display()
                    );
                    assert!(
                        !compact.contains("reqwest::get("),
                        "direct GET: {}",
                        path.display()
                    );
                }
            }
        }
        check(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
    }

    #[tokio::test]
    async fn fixture_opt_in_is_not_deserializable() {
        let spec: RequestSpec =
            serde_json::from_str(r#"{"url":"http://127.0.0.1:9/fixture","testLoopback":true}"#)
                .unwrap();
        assert!(!spec.test_loopback);
        assert!(matches!(
            spec.send(&build_client().unwrap(), None).await,
            Err(DownloadError::InvalidRequest(_))
        ));
    }

    #[tokio::test]
    async fn probe_and_fetch_reject_non_public_destinations() {
        let client = build_client().unwrap();
        let spec = RequestSpec::get("http://127.0.0.1:9/fixture");
        assert!(matches!(
            crate::probe::probe(&client, &spec).await,
            Err(DownloadError::InvalidRequest(_))
        ));
        let fetcher = crate::fetch::Fetcher {
            client,
            spec: spec.clone(),
            max_retries: 0,
            retry_base_delay: Duration::ZERO,
            cancel: tokio_util::sync::CancellationToken::new(),
            tracker: None,
            limiter: None,
        };
        assert!(matches!(
            fetcher.get(&spec.url, None).await,
            Err(DownloadError::InvalidRequest(_))
        ));
    }

    #[tokio::test]
    async fn secure_transport_preserves_local_probe_fetch_and_http_fixtures() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Both segmented and single-stream paths must continue to work with the
        // existing test-only opt-in. No external DNS, proxy or network is needed.
        for segmented in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/fixture", listener.local_addr().unwrap());
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let requests = seen.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    loop {
                        let mut buf = [0; 1024];
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..n]);
                        if request.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let text = String::from_utf8(request).unwrap().to_ascii_lowercase();
                    requests.lock().unwrap().push(text.clone());
                    let range = text
                        .lines()
                        .find_map(|line| line.strip_prefix("range: bytes="));
                    let (status, extra, body) = if let Some(range) = range.filter(|_| segmented) {
                        let (start, end) = range.split_once('-').unwrap();
                        let start: usize = start.parse().unwrap();
                        let end: usize = end.parse().unwrap();
                        (
                            "206 Partial Content",
                            format!("Content-Range: bytes {start}-{end}/4\r\n"),
                            &b"data"[start..=end],
                        )
                    } else {
                        ("200 OK", String::new(), &b"data"[..])
                    };
                    let headers = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
                    stream.write_all(headers.as_bytes()).await.unwrap();
                    if !text.starts_with("head ") {
                        stream.write_all(body).await.unwrap();
                    }
                }
            });
            let mut spec = RequestSpec::get(&url);
            spec.test_loopback = true;
            let client = build_client().unwrap();
            let cancel = tokio_util::sync::CancellationToken::new();
            let fetcher = crate::fetch::Fetcher {
                client: client.clone(),
                spec: spec.clone(),
                max_retries: 0,
                retry_base_delay: Duration::ZERO,
                cancel: cancel.clone(),
                tracker: None,
                limiter: None,
            };
            let fetched = tokio::time::timeout(Duration::from_secs(5), fetcher.get(&url, None))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&fetched[..], b"data");
            let dir = tempfile::tempdir().unwrap();
            let (tracker, _) = crate::progress::ProgressTracker::new(None);
            let options = crate::http::HttpOptions {
                connections: 2,
                max_retries: 0,
                min_split_size: 1,
                ..Default::default()
            };
            let output = tokio::time::timeout(
                Duration::from_secs(5),
                crate::http::download_http(
                    &client,
                    &spec,
                    dir.path(),
                    Some("fixture.bin"),
                    &options,
                    &cancel,
                    &tracker,
                    None,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(std::fs::read(output.path).unwrap(), b"data");
            server.abort();
            let _ = server.await;
            let requests = seen.lock().unwrap();
            assert!(requests.iter().any(|r| r.starts_with("head ")));
            assert!(requests.iter().any(|r| r.contains("range: bytes=0-0")));
            if segmented {
                assert!(
                    requests
                        .iter()
                        .filter(|r| r.contains("range: bytes="))
                        .count()
                        >= 2
                );
            } else {
                assert_eq!(
                    requests
                        .iter()
                        .filter(|r| r.starts_with("get ") && !r.contains("range:"))
                        .count(),
                    2
                );
            }
        }
    }

    #[test]
    fn build_applies_auth_context() {
        let mut spec = RequestSpec::get("http://localhost/file");
        spec.cookies = Some("a=b".into());
        spec.referer = Some("http://ref/".into());
        spec.headers.push(("X-Test".into(), "1".into()));
        spec.headers.push(("Range".into(), "bytes=5-".into()));
        let client = build_client().unwrap();
        let req = spec
            .build(&client, Some("bytes=0-9"))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(req.headers()["cookie"], "a=b");
        assert_eq!(req.headers()["referer"], "http://ref/");
        assert_eq!(req.headers()["x-test"], "1");
        assert_eq!(req.headers()["range"], "bytes=0-9");
    }
}
