//! Shared plumbing for the provider adapters: an incremental SSE parser, HTTP
//! status handling, secret redaction and the event-handler driver.

use std::collections::VecDeque;
use std::pin::Pin;

use futures_util::{Stream, StreamExt};
use serde_json::Value;

use super::record::{ExchangeHandle, Recorder};
use super::ProviderStream;
use crate::{Block, HarnessError, HarnessResult, StreamEvent};

/// One dispatched server-sent event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Maximum raw bytes in one SSE line, excluding its CR/LF terminator.
pub const MAX_SSE_LINE_BYTES: usize = 256 * 1024;
/// Maximum decoded UTF-8 bytes in the current event name and joined data.
pub const MAX_SSE_EVENT_BYTES: usize = 2 * 1024 * 1024;

/// Incremental, bounded SSE parser. Each pull consumes through at most one
/// dispatched event, so a large transport chunk never creates an event batch.
/// UTF-8 is decoded only once a complete line is available. CR, LF and CRLF
/// delimiters are accepted even when CRLF/UTF-8 is split across chunks.
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Option<String>,
    skip_lf: bool,
    failed: bool,
    finished: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    fn limit_error(message: &'static str) -> HarnessError {
        HarnessError::Provider {
            status: None,
            message: message.to_owned(),
            retryable: false,
        }
    }

    fn fail<T>(&mut self, message: &'static str) -> HarnessResult<T> {
        self.failed = true;
        self.buf = Vec::new();
        self.event = None;
        self.data = None;
        Err(Self::limit_error(message))
    }

    /// Consume up to one event and return `(bytes_consumed, event)`. The caller
    /// retains the unconsumed suffix and calls again before polling transport.
    /// A nonempty input always makes progress unless an error is returned.
    /// After a limit error the parser is poisoned; no later input is accepted.
    pub fn next_event(&mut self, chunk: &[u8]) -> HarnessResult<(usize, Option<SseEvent>)> {
        if self.failed {
            return Err(Self::limit_error(
                "SSE parser stopped after a resource limit violation",
            ));
        }
        if self.finished {
            return Err(Self::limit_error("SSE parser already finished"));
        }
        let mut offset = 0;
        while offset < chunk.len() {
            if self.skip_lf {
                self.skip_lf = false;
                if chunk[offset] == b'\n' {
                    offset += 1;
                    continue;
                }
            }
            let tail = &chunk[offset..];
            let length = tail
                .iter()
                .position(|b| matches!(b, b'\r' | b'\n'))
                .unwrap_or(tail.len());
            if length > MAX_SSE_LINE_BYTES - self.buf.len() {
                return self.fail("SSE line exceeds the 256 KiB raw-byte limit");
            }
            self.buf.extend_from_slice(&tail[..length]);
            offset += length;
            if offset == chunk.len() {
                break;
            }
            self.skip_lf = chunk[offset] == b'\r';
            offset += 1;
            let line = std::mem::take(&mut self.buf);
            let text = String::from_utf8_lossy(&line);
            if let Some(event) = self.line(&text)? {
                return Ok((offset, Some(event)));
            }
        }
        Ok((offset, None))
    }

    /// Flush a final unterminated event for compatibility with existing provider
    /// adapters. This is an explicit Omnia EOF policy, not a strict SSE claim.
    /// Repeated successful finish calls return no additional event.
    pub fn finish(&mut self) -> HarnessResult<Option<SseEvent>> {
        if self.failed {
            return Err(Self::limit_error(
                "SSE parser stopped after a resource limit violation",
            ));
        }
        if self.finished {
            return Ok(None);
        }
        self.finished = true;
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            let text = String::from_utf8_lossy(&line);
            self.line(&text)?;
        }
        Ok(self.dispatch())
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = self.event.take();
        self.data.take().map(|data| SseEvent { event, data })
    }

    fn line(&mut self, line: &str) -> HarnessResult<Option<SseEvent>> {
        if line.is_empty() {
            return Ok(self.dispatch());
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        let name_len = self.event.as_ref().map_or(0, String::len);
        let data_len = self.data.as_ref().map_or(0, String::len);
        let new_size = match field {
            "event" => value.len().checked_add(data_len),
            "data" => name_len
                .checked_add(data_len)
                .and_then(|n| n.checked_add(usize::from(self.data.is_some())))
                .and_then(|n| n.checked_add(value.len())),
            _ => return Ok(None),
        };
        if !matches!(new_size, Some(size) if size <= MAX_SSE_EVENT_BYTES) {
            return self.fail("SSE event exceeds the 2 MiB decoded-byte limit");
        }
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_owned()),
            },
            _ => unreachable!(),
        }
        Ok(None)
    }
}

fn stream_error(message: impl std::fmt::Display) -> HarnessError {
    HarnessError::Provider {
        status: None,
        message: redact_secrets(&format!("stream interrupted: {message}")),
        retryable: true,
    }
}

/// Turn any byte-chunk stream into SSE events, one event per consumer pull.
/// The driver retains at most one upstream-owned chunk and no event queue.
/// Limits bound parser-owned data, not allocation already made by transport.
pub fn sse_from_bytes<S, B, E>(bytes: S) -> impl Stream<Item = HarnessResult<SseEvent>> + Send
where
    S: Stream<Item = Result<B, E>> + Send + 'static,
    B: AsRef<[u8]> + Send,
    E: std::fmt::Display + Send,
{
    struct State<S, B> {
        inner: Pin<Box<S>>,
        parser: SseParser,
        chunk: Option<B>,
        offset: usize,
        done: bool,
    }
    futures_util::stream::unfold(
        State {
            inner: Box::pin(bytes),
            parser: SseParser::new(),
            chunk: None,
            offset: 0,
            done: false,
        },
        |mut st: State<S, B>| async move {
            let mut processed_bytes = 0usize;
            let mut processed_chunks = 0usize;
            loop {
                // Ready-only keepalive/empty sources must not starve cancellation.
                if processed_bytes >= 64 * 1024 || processed_chunks >= 32 {
                    tokio::task::yield_now().await;
                    processed_bytes = 0;
                    processed_chunks = 0;
                }
                if st.done {
                    return None;
                }
                if let Some(chunk) = &st.chunk {
                    let end = (st.offset + 64 * 1024).min(chunk.as_ref().len());
                    match st.parser.next_event(&chunk.as_ref()[st.offset..end]) {
                        Ok((consumed, event)) => {
                            processed_bytes += consumed;
                            st.offset += consumed;
                            if st.offset == chunk.as_ref().len() {
                                st.chunk = None;
                                st.offset = 0;
                            }
                            if let Some(event) = event {
                                return Some((Ok(event), st));
                            }
                        }
                        Err(error) => {
                            st.done = true;
                            st.chunk = None;
                            return Some((Err(error), st));
                        }
                    }
                    continue;
                }
                match st.inner.next().await {
                    Some(Ok(chunk)) => {
                        processed_chunks += 1;
                        st.chunk = Some(chunk);
                    }
                    Some(Err(error)) => {
                        st.done = true;
                        return Some((Err(stream_error(error)), st));
                    }
                    None => {
                        st.done = true;
                        return match st.parser.finish() {
                            Ok(Some(event)) => Some((Ok(event), st)),
                            Ok(None) => None,
                            Err(error) => Some((Err(error), st)),
                        };
                    }
                }
            }
        },
    )
    .fuse()
}

/// SSE events of an HTTP response body.
pub fn sse_events(resp: reqwest::Response) -> impl Stream<Item = HarnessResult<SseEvent>> + Send {
    sse_from_bytes(resp.bytes_stream())
}

/// Per-provider translation of SSE events to normalized events.
pub trait EventHandler: Send + 'static {
    fn on_event(&mut self, event: &SseEvent) -> HarnessResult<Vec<StreamEvent>>;
    /// Called once when the transport stream ends cleanly.
    fn on_end(&mut self) -> HarnessResult<Vec<StreamEvent>>;
}

/// Drive `handler` over `events`, producing the provider stream. The stream
/// terminates after the first error.
pub fn handle_events<S, H>(events: S, handler: H) -> ProviderStream
where
    S: Stream<Item = HarnessResult<SseEvent>> + Send + 'static,
    H: EventHandler,
{
    struct State<S, H> {
        inner: Pin<Box<S>>,
        handler: H,
        queue: VecDeque<StreamEvent>,
        done: bool,
    }
    Box::pin(futures_util::stream::unfold(
        State {
            inner: Box::pin(events),
            handler,
            queue: VecDeque::new(),
            done: false,
        },
        |mut st| async move {
            loop {
                if let Some(event) = st.queue.pop_front() {
                    return Some((Ok(event), st));
                }
                if st.done {
                    return None;
                }
                match st.inner.next().await {
                    Some(Ok(event)) => match st.handler.on_event(&event) {
                        Ok(out) => st.queue.extend(out),
                        Err(error) => {
                            st.done = true;
                            return Some((Err(error), st));
                        }
                    },
                    Some(Err(error)) => {
                        st.done = true;
                        return Some((Err(error), st));
                    }
                    None => {
                        st.done = true;
                        match st.handler.on_end() {
                            Ok(out) => st.queue.extend(out),
                            Err(error) => return Some((Err(error), st)),
                        }
                    }
                }
            }
        },
    ))
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// Replace anything that looks like an API key / token with `[REDACTED]`.
pub fn redact_secrets(text: &str) -> String {
    fn is_secret(token: &str) -> bool {
        let len = token.len();
        (token.starts_with("sk-") && len >= 12)
            || (token.starts_with("AIza") && len >= 30)
            || (len >= 32
                && token.chars().any(|c| c.is_ascii_digit())
                && token.chars().any(|c| c.is_ascii_alphabetic()))
    }
    fn flush(run: &mut String, out: &mut String) {
        if is_secret(run) {
            out.push_str("[REDACTED]");
        } else {
            out.push_str(run);
        }
        run.clear();
    }
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

const MAX_ERROR_CHARS: usize = 600;

pub fn is_retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

/// Build a provider error from an HTTP status and response body.
pub fn provider_error(status: u16, body: &str) -> HarnessError {
    let extracted = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        let err = v.get("error").unwrap_or(&v);
        err.get("message")
            .and_then(Value::as_str)
            .or_else(|| err.as_str())
            .map(str::to_string)
    });
    let raw = extracted.unwrap_or_else(|| body.trim().to_string());
    let mut message = redact_secrets(&raw);
    if message.chars().count() > MAX_ERROR_CHARS {
        message = message.chars().take(MAX_ERROR_CHARS).collect::<String>() + "...";
    }
    if message.is_empty() {
        message = format!("HTTP {status}");
    }
    HarnessError::Provider {
        status: Some(status),
        message,
        retryable: is_retryable_status(status),
    }
}

/// Error for a failed in-stream error event (no HTTP status).
pub fn stream_event_error(message: &str, retryable: bool) -> HarnessError {
    HarnessError::Provider {
        status: None,
        message: redact_secrets(message),
        retryable,
    }
}

/// Pass successful responses through; turn error statuses into `Provider`.
pub async fn check_response(resp: reqwest::Response) -> HarnessResult<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(provider_error(status.as_u16(), &body))
}

fn transport_error(error: reqwest::Error) -> HarnessError {
    let status = error.status().map(|s| s.as_u16());
    let retryable = error.is_timeout() || error.is_connect() || error.is_request();
    HarnessError::Provider {
        status,
        message: redact_secrets(&error.without_url().to_string()),
        retryable,
    }
}

/// Like [`post_json`], additionally recording the exchange when `recorder` is
/// set. The returned handle must be attached to the response body with
/// [`sse_events_tap`].
pub async fn post_json_logged(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    body: &Value,
    recorder: Option<&Recorder>,
    provider: &str,
    model: &str,
) -> HarnessResult<(reqwest::Response, Option<ExchangeHandle>)> {
    let Some(recorder) = recorder else {
        return Ok((post_json(client, url, headers, body).await?, None));
    };
    let mut logged = vec![
        ("accept".to_owned(), "text/event-stream".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ];
    logged.extend(headers.iter().cloned());
    let mut handle = recorder.log.begin(provider, model, url, &logged, body);
    let mut builder = client
        .post(url)
        .header("accept", "text/event-stream")
        .json(body);
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let resp = match builder.send().await {
        Ok(resp) => resp,
        Err(error) => {
            let error = transport_error(error);
            handle.fail(error.to_string());
            return Err(error);
        }
    };
    let status = resp.status();
    let response_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    handle.set_response(status.as_u16(), &response_headers);
    if status.is_success() {
        return Ok((resp, Some(handle)));
    }
    let text = resp.text().await.unwrap_or_default();
    handle.push_chunk(text.as_bytes());
    let error = provider_error(status.as_u16(), &text);
    handle.fail(error.to_string());
    Err(error)
}

/// SSE events of a response body, teeing the raw bytes into `tap`.
pub fn sse_events_tap(
    resp: reqwest::Response,
    tap: Option<ExchangeHandle>,
) -> impl Stream<Item = HarnessResult<SseEvent>> + Send {
    let mut tap = tap;
    sse_from_bytes(resp.bytes_stream().map(move |item| {
        if let Some(handle) = tap.as_mut() {
            match &item {
                Ok(chunk) => handle.push_chunk(chunk.as_ref()),
                Err(error) => handle.fail(format!("stream interrupted: {error}")),
            }
        }
        item
    }))
}

/// POST a JSON body with the given headers and return the checked response.
pub async fn post_json(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    body: &Value,
) -> HarnessResult<reqwest::Response> {
    let mut builder = client
        .post(url)
        .header("accept", "text/event-stream")
        .json(body);
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let resp = builder.send().await.map_err(transport_error)?;
    check_response(resp).await
}

/// `base` + `path`, inserting `/v1` unless the base already ends in a version
/// segment (`/v1`, `/v1beta`, `/api/v3`, ...).
pub fn versioned_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let last = base.rsplit('/').next().unwrap_or("");
    let versioned = last.len() > 1
        && last.starts_with('v')
        && last[1..].chars().next().is_some_and(|c| c.is_ascii_digit());
    if versioned {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    }
}

/// Auth + extra headers shared by all adapters.
pub fn auth_headers(
    config: &super::ProviderConfig,
    key_header: &str,
    fixed: &[(&str, &str)],
) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = fixed
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if let Some(key) = config.api_key.as_deref().filter(|k| !k.is_empty()) {
        if config.bearer_auth {
            headers.push(("authorization".into(), format!("Bearer {key}")));
        } else {
            headers.push((key_header.into(), key.to_string()));
        }
    }
    headers.extend(config.extra_headers.iter().cloned());
    headers
}

pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Concatenated text of the text blocks.
pub fn blocks_text(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// f32 -> JSON number without widening noise (0.1f32 stays 0.1).
pub fn temp_json(t: f32) -> Value {
    let v = t.to_string().parse::<f64>().unwrap_or(t as f64);
    serde_json::json!(v)
}

pub fn data_uri(media_type: &str, data: &str) -> String {
    format!("data:{media_type};base64,{data}")
}

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read, Write};

    use futures_util::StreamExt;

    use super::*;
    use crate::{Message, MessageAccumulator, StopReason, Usage};

    pub fn split_chunks(s: &str, n: usize) -> Vec<Vec<u8>> {
        s.as_bytes().chunks(n).map(|c| c.to_vec()).collect()
    }

    pub async fn run_handler<H: EventHandler>(
        chunks: Vec<Vec<u8>>,
        handler: H,
    ) -> HarnessResult<Vec<StreamEvent>> {
        let bytes = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, String>));
        let mut stream = handle_events(sse_from_bytes(bytes), handler);
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            out.push(item?);
        }
        Ok(out)
    }

    /// Run a fixture whole, in 7-byte and in 1-byte chunks; all must agree.
    pub async fn run_fixture<H: EventHandler>(
        fixture: &str,
        make: impl Fn() -> H,
    ) -> Vec<StreamEvent> {
        let whole = run_handler(vec![fixture.as_bytes().to_vec()], make())
            .await
            .unwrap();
        for n in [1usize, 7, 64] {
            let split = run_handler(split_chunks(fixture, n), make()).await.unwrap();
            assert_eq!(whole, split, "chunk size {n} changed the result");
        }
        whole
    }

    pub fn fold(events: &[StreamEvent]) -> (Message, Usage, StopReason) {
        let mut acc = MessageAccumulator::default();
        for event in events {
            acc.push(event).unwrap();
        }
        acc.finish()
    }

    pub fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// Serve exactly one HTTP request; returns (base_url, join handle that
    /// yields the raw request text).
    pub fn serve_once(
        status: u16,
        content_type: &str,
        body: String,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let content_type = content_type.to_string();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut data = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = socket.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&tmp[..n]);
                if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&data[..pos]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if data.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            let head = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n"
            );
            socket.write_all(head.as_bytes()).unwrap();
            let bytes = body.as_bytes();
            let mid = bytes.len() / 2;
            socket.write_all(&bytes[..mid]).unwrap();
            socket.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
            socket.write_all(&bytes[mid..]).unwrap();
            socket.flush().unwrap();
            String::from_utf8_lossy(&data).into_owned()
        });
        (base, handle)
    }

    pub async fn collect_stream(mut stream: ProviderStream) -> HarnessResult<Vec<StreamEvent>> {
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            out.push(item?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn parse_all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for c in chunks {
            let mut offset = 0;
            while offset < c.len() {
                let (consumed, event) = p.next_event(&c[offset..]).unwrap();
                assert!(consumed > 0);
                offset += consumed;
                out.extend(event);
            }
        }
        out.extend(p.finish().unwrap());
        out
    }

    fn ev(event: Option<&str>, data: &str) -> SseEvent {
        SseEvent {
            event: event.map(str::to_string),
            data: data.to_string(),
        }
    }

    #[test]
    fn parses_lf_crlf_multiline_and_comments() {
        let input = ": keepalive\nevent: a\ndata: one\ndata: two\n\r\ndata:{\"x\":1}\r\n\r\nid: 5\nretry: 10\n\n";
        let got = parse_all(&[input.as_bytes()]);
        assert_eq!(got, vec![ev(Some("a"), "one\ntwo"), ev(None, "{\"x\":1}")]);
    }

    #[test]
    fn crlf_split_between_chunks_and_utf8_split() {
        let input = "data: h\u{e9}llo \u{1F600}\r\n\r\ndata: b\r\n\r\n";
        let bytes = input.as_bytes();
        for n in 1..bytes.len() {
            let (a, b) = bytes.split_at(n);
            let got = parse_all(&[a, b]);
            assert_eq!(
                got,
                vec![ev(None, "h\u{e9}llo \u{1F600}"), ev(None, "b")],
                "split {n}"
            );
        }
    }

    #[test]
    fn flushes_unterminated_final_event() {
        let got = parse_all(&[b"data: tail"]);
        assert_eq!(got, vec![ev(None, "tail")]);
    }

    #[test]
    fn event_without_data_is_dropped() {
        assert!(parse_all(&[b"event: ping\n\n"]).is_empty());
    }

    #[test]
    fn cr_only_lines_and_split_crlf_produce_identical_events() {
        let expected = vec![ev(Some("a"), "one\ntwo"), ev(None, "last")];
        for input in [
            "event: a\rdata: one\rdata: two\r\rdata: last\r\r",
            "event: a\r\ndata: one\r\ndata: two\r\n\r\ndata: last\r\n\r\n",
        ] {
            for split in 0..=input.len() {
                let (a, b) = input.as_bytes().split_at(split);
                assert_eq!(parse_all(&[a, b]), expected, "split {split}");
            }
        }
    }

    #[test]
    fn raw_line_limit_accepts_exact_boundary_and_poison_releases_buffers() {
        let mut line = b"data: ".to_vec();
        line.resize(MAX_SSE_LINE_BYTES, b'x');
        let mut parser = SseParser::new();
        for chunk in line.chunks(16381) {
            assert_eq!(parser.next_event(chunk).unwrap(), (chunk.len(), None));
        }
        assert_eq!(parser.buf.len(), MAX_SSE_LINE_BYTES);
        let (_, event) = parser.next_event(b"\n\n").unwrap();
        assert_eq!(event.unwrap().data.len(), MAX_SSE_LINE_BYTES - 6);
        assert!(parser.finish().unwrap().is_none());
        assert!(parser.finish().unwrap().is_none());

        let mut parser = SseParser::new();
        parser.next_event(&line).unwrap();
        let error = parser.next_event(b"x").unwrap_err();
        assert!(matches!(
            error,
            HarnessError::Provider {
                retryable: false,
                ..
            }
        ));
        assert!(parser.buf.is_empty());
        assert_eq!(parser.buf.capacity(), 0);
        assert!(parser.event.is_none() && parser.data.is_none());
        assert!(parser.next_event(b"\n\ndata: secret\n\n").is_err());
        assert!(parser.finish().is_err());
        assert!(!error.to_string().contains("secret"));
    }

    /// Build an event whose decoded data byte count is exactly `size`.
    fn event_with_data_size(size: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut remaining = size;
        let mut first = true;
        loop {
            if !first {
                remaining -= 1; // newline inserted between successive data lines
            }
            let count = remaining.min(MAX_SSE_LINE_BYTES - 6);
            bytes.extend_from_slice(b"data: ");
            bytes.resize(bytes.len() + count, b'x');
            bytes.push(b'\n');
            remaining -= count;
            if remaining == 0 {
                break;
            }
            first = false;
        }
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn decoded_event_limit_counts_multiline_joins_and_event_name() {
        let exact = event_with_data_size(MAX_SSE_EVENT_BYTES);
        let mut parser = SseParser::new();
        let (consumed, event) = parser.next_event(&exact).unwrap();
        assert_eq!(consumed, exact.len());
        assert_eq!(event.unwrap().data.len(), MAX_SSE_EVENT_BYTES);

        let excess = event_with_data_size(MAX_SSE_EVENT_BYTES + 1);
        let mut parser = SseParser::new();
        let error = parser.next_event(&excess).unwrap_err();
        assert!(matches!(
            error,
            HarnessError::Provider {
                retryable: false,
                ..
            }
        ));
        assert!(parser.buf.is_empty() && parser.data.is_none());

        let mut named = b"event: a\n".to_vec();
        named.extend_from_slice(&exact);
        assert!(SseParser::new().next_event(&named).is_err());
        let mut named_exact = b"event: a\n".to_vec();
        named_exact.extend_from_slice(&event_with_data_size(MAX_SSE_EVENT_BYTES - 1));
        let (_, event) = SseParser::new().next_event(&named_exact).unwrap();
        let event = event.unwrap();
        assert_eq!(
            event.data.len() + event.event.unwrap().len(),
            MAX_SSE_EVENT_BYTES
        );
    }

    #[test]
    fn invalid_utf8_expansion_is_included_in_event_budget() {
        let mut parser = SseParser::new();
        let mut raw = b"data: ".to_vec();
        raw.resize(MAX_SSE_LINE_BYTES, 0xff);
        raw.push(b'\n');
        parser.next_event(&raw).unwrap();
        parser.next_event(&raw).unwrap();
        let error = parser.next_event(&raw).unwrap_err();
        assert!(matches!(
            error,
            HarnessError::Provider {
                retryable: false,
                ..
            }
        ));
        assert!(parser.buf.is_empty() && parser.data.is_none());
    }

    #[test]
    fn large_chunk_is_consumed_only_through_next_event() {
        let input = b"data: x\n\n".repeat(100_000);
        let mut parser = SseParser::new();
        let (consumed, event) = parser.next_event(&input).unwrap();
        assert_eq!(consumed, b"data: x\n\n".len());
        assert_eq!(event, Some(ev(None, "x")));
        assert!(parser.buf.is_empty() && parser.data.is_none());
    }

    #[tokio::test]
    async fn parser_limit_error_is_terminal_and_does_not_poll_transport_again() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&polls);
        let source = futures_util::stream::poll_fn(move |_| {
            let index = observed.fetch_add(1, Ordering::SeqCst);
            std::task::Poll::Ready(Some(Ok::<_, String>(if index == 0 {
                vec![b'x'; MAX_SSE_LINE_BYTES + 1]
            } else {
                b"data: must not be polled\n\n".to_vec()
            })))
        });
        let mut stream = Box::pin(sse_from_bytes(source));
        assert!(matches!(
            stream.next().await.unwrap(),
            Err(HarnessError::Provider {
                retryable: false,
                ..
            })
        ));
        assert!(stream.next().await.is_none());
        assert!(stream.next().await.is_none());
        assert_eq!(polls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn many_valid_events_in_one_chunk_are_yielded_without_extra_transport_polls() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&polls);
        let mut chunk = Some(b"data: x\n\n".repeat(8192));
        let source = futures_util::stream::poll_fn(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            std::task::Poll::Ready(chunk.take().map(Ok::<_, String>))
        });
        let mut stream = Box::pin(sse_from_bytes(source));
        for _ in 0..8192 {
            assert_eq!(stream.next().await.unwrap().unwrap(), ev(None, "x"));
            assert_eq!(polls.load(Ordering::SeqCst), 1);
        }
        assert!(stream.next().await.is_none());
        assert_eq!(polls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ready_only_keepalives_and_empty_chunks_allow_cancellation() {
        for chunk in [
            Vec::new(),
            b": keepalive\n".to_vec(),
            b":\n".repeat(100_000),
        ] {
            let source = futures_util::stream::repeat(Ok::<_, String>(chunk));
            let mut stream = Box::pin(sse_from_bytes(source));
            // Without cooperative yielding this timeout cannot run on this thread.
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), stream.next(),)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn byte_stream_error_becomes_retryable_provider_error() {
        let items: Vec<Result<Vec<u8>, String>> =
            vec![Ok(b"data: a\n\n".to_vec()), Err("boom".into())];
        let mut s = Box::pin(sse_from_bytes(futures_util::stream::iter(items)));
        assert_eq!(s.next().await.unwrap().unwrap(), ev(None, "a"));
        match s.next().await.unwrap() {
            Err(HarnessError::Provider {
                retryable: true, ..
            }) => {}
            other => panic!("unexpected {other:?}"),
        }
        assert!(s.next().await.is_none());
    }

    #[test]
    fn redacts_keys_and_classifies_status() {
        let body = r#"{"error":{"message":"bad key sk-abcdef1234567890XYZ and AIzaSyA1234567890123456789012345678901"}}"#;
        match provider_error(401, body) {
            HarnessError::Provider {
                status,
                message,
                retryable,
            } => {
                assert_eq!(status, Some(401));
                assert!(!retryable);
                assert!(!message.contains("sk-abc"));
                assert!(!message.contains("AIza"));
                assert!(message.contains("[REDACTED]"));
            }
            _ => panic!(),
        }
        for s in [429u16, 500, 503, 529] {
            assert!(matches!(
                provider_error(s, "x"),
                HarnessError::Provider {
                    retryable: true,
                    ..
                }
            ));
        }
        assert!(matches!(
            provider_error(400, "x"),
            HarnessError::Provider {
                retryable: false,
                ..
            }
        ));
        let long = "a b ".repeat(1000);
        match provider_error(500, &long) {
            HarnessError::Provider { message, .. } => assert!(message.chars().count() < 700),
            _ => panic!(),
        }
    }

    #[test]
    fn versioned_url_handles_both_base_forms() {
        assert_eq!(
            versioned_url("http://h:1", "chat/completions"),
            "http://h:1/v1/chat/completions"
        );
        assert_eq!(
            versioned_url("http://h:1/v1/", "chat/completions"),
            "http://h:1/v1/chat/completions"
        );
        assert_eq!(
            versioned_url("https://x/api/v3", "responses"),
            "https://x/api/v3/responses"
        );
        assert_eq!(
            versioned_url("https://api.openai.com", "responses"),
            "https://api.openai.com/v1/responses"
        );
    }

    #[tokio::test]
    async fn http_error_status_maps_to_provider_error() {
        let (base, handle) = serve_once(
            429,
            "application/json",
            r#"{"error":{"message":"slow down"}}"#.into(),
        );
        let err = post_json(&test_client(), &base, &[], &serde_json::json!({}))
            .await
            .unwrap_err();
        handle.join().unwrap();
        match err {
            HarnessError::Provider {
                status: Some(429),
                message,
                retryable: true,
            } => {
                assert_eq!(message, "slow down")
            }
            other => panic!("{other:?}"),
        }
    }
}
