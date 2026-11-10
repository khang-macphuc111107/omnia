//! JSON-RPC over stdio framing (`Content-Length` headers).

use serde_json::Value;

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Serialises `msg` with its `Content-Length` header.
pub fn encode(msg: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(msg).unwrap_or_default();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Incremental decoder: feed arbitrary chunks, pull complete messages.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Next complete message, `Ok(None)` when more bytes are needed. A malformed
    /// frame is dropped (header errors clear the buffer) and reported once.
    pub fn next_message(&mut self) -> Result<Option<Value>, String> {
        let Some(end) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            if self.buf.len() > MAX_HEADER {
                self.buf.clear();
                return Err("LSP header too large".into());
            }
            return Ok(None);
        };
        let len = match parse_length(&self.buf[..end]) {
            Ok(len) => len,
            Err(error) => {
                self.buf.clear();
                return Err(error);
            }
        };
        let total = end + 4 + len;
        if self.buf.len() < total {
            return Ok(None);
        }
        let parsed = serde_json::from_slice(&self.buf[end + 4..total]);
        self.buf.drain(..total);
        parsed
            .map(Some)
            .map_err(|e| format!("invalid LSP JSON: {e}"))
    }
}

fn parse_length(head: &[u8]) -> Result<usize, String> {
    let head = std::str::from_utf8(head).map_err(|_| "non-UTF-8 LSP header".to_string())?;
    for line in head.split("\r\n") {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                let len: usize = value
                    .trim()
                    .parse()
                    .map_err(|_| format!("bad Content-Length `{}`", value.trim()))?;
                if len > MAX_BODY {
                    return Err("LSP message too large".into());
                }
                return Ok(len);
            }
        }
    }
    Err("missing Content-Length header".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_and_partial_reads() {
        let bytes = encode(&json!({"jsonrpc":"2.0","id":1,"result":"héllo 😀"}));
        let mut dec = Decoder::default();
        for chunk in bytes.chunks(3) {
            assert!(dec.next_message().unwrap().is_none());
            dec.push(chunk);
        }
        let msg = dec.next_message().unwrap().unwrap();
        assert_eq!(msg["result"], "héllo 😀");
        assert!(dec.next_message().unwrap().is_none());
    }

    #[test]
    fn multiple_messages_per_chunk() {
        let mut all = encode(&json!({"id":1}));
        all.extend(encode(&json!({"id":2})));
        all.extend(encode(&json!({"id":3})));
        let mut dec = Decoder::default();
        dec.push(&all[..all.len() - 2]);
        assert_eq!(dec.next_message().unwrap().unwrap()["id"], 1);
        assert_eq!(dec.next_message().unwrap().unwrap()["id"], 2);
        assert!(dec.next_message().unwrap().is_none());
        dec.push(&all[all.len() - 2..]);
        assert_eq!(dec.next_message().unwrap().unwrap()["id"], 3);
    }

    #[test]
    fn extra_headers_and_case() {
        let mut dec = Decoder::default();
        dec.push(b"content-length: 2\r\nContent-Type: x\r\n\r\n{}");
        assert_eq!(dec.next_message().unwrap().unwrap(), json!({}));
    }

    #[test]
    fn malformed_frames_recover() {
        let mut dec = Decoder::default();
        dec.push(b"Foo: 1\r\n\r\n");
        assert!(dec.next_message().is_err());
        dec.push(b"Content-Length: 3\r\n\r\nabc");
        assert!(dec.next_message().is_err());
        dec.push(&encode(&json!({"ok":true})));
        assert_eq!(dec.next_message().unwrap().unwrap()["ok"], true);
    }
}
