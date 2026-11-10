//! Trust boundaries for DevTools endpoints, page targets and diagnostic URLs.
use crate::{BrowserError, Result};

/// DevTools has full browser privileges. Only numeric loopback hosts are accepted
/// (localhost is normalized to 127.0.0.1; no DNS rebinding or remote endpoints).
pub fn local_endpoint(raw: &str, websocket: bool) -> Result<url::Url> {
    let mut url = url::Url::parse(raw)
        .map_err(|_| BrowserError::Invalid("invalid DevTools endpoint".into()))?;
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| BrowserError::Invalid("invalid loopback host".into()))?;
    }
    let local = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if !local
        || url.scheme() != if websocket { "ws" } else { "http" }
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BrowserError::Invalid(
            "DevTools requires an unauthenticated loopback ws/http endpoint".into(),
        ));
    }
    Ok(url)
}

/// Browser tools cannot address local files, internal browser pages or script
/// URLs. Ordinary HTTP(S) pages and a blank new tab are supported.
pub fn navigation_url(raw: &str) -> Result<url::Url> {
    let url =
        url::Url::parse(raw).map_err(|_| BrowserError::Invalid("invalid navigation URL".into()))?;
    if raw == "about:blank" {
        return Ok(url);
    }
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(BrowserError::Invalid(
            "navigation requires HTTP(S) without embedded credentials, or about:blank".into(),
        ));
    }
    Ok(url)
}

/// UI/agent network listings hide every query value, fragments and userinfo.
/// Raw URLs remain available only in the explicit authorized replay handoff.
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "[invalid URL]".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    if url.query().is_some() {
        url.set_query(Some("REDACTED"));
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_are_loopback_only() {
        for raw in [
            "ws://evil.test:9222",
            "ws://127.0.0.1.evil.test",
            "wss://127.0.0.1",
            "ws://user:secret@127.0.0.1",
            "ws://127.0.0.1?token=s",
        ] {
            assert!(local_endpoint(raw, true).is_err(), "{raw}");
        }
        assert!(local_endpoint("ws://[::1]:1/devtools/browser/x", true).is_ok());
        assert_eq!(
            local_endpoint("ws://localhost:1", true).unwrap().host_str(),
            Some("127.0.0.1")
        );
    }
    #[test]
    fn navigation_blocks_privileged_targets() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "chrome://settings",
            "data:text/html,x",
            "https://user:secret@example.com",
        ] {
            assert!(navigation_url(raw).is_err(), "{raw}");
        }
        assert!(navigation_url("http://localhost:123/fixture").is_ok());
        assert!(navigation_url("about:blank").is_ok());
    }
    #[test]
    fn url_redaction_hides_credentials_and_signed_queries() {
        assert_eq!(
            redact_url("https://u:p@example.com/video?sig=secret#token"),
            "https://example.com/video?REDACTED"
        );
    }
}
