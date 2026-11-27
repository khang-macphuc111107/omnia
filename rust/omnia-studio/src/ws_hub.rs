//! Multiplexed RFC 6455 WebSocket (`/ws`) over `tokio-tungstenite` supporting:
//! - Live multiplexed JSON event streaming from [`EventFeed`] (`agent|swarm|downloads|browser|workspace|router|mcp`)
//! - Binary & JSON ConPTY/terminal streaming (`[0x01|id_len|id|stdout]`, `[0x00|id_len|id|stdin]`, or raw PTY stream via `?ptyId=<id>`)
//! - Client control messages (`subscribe`, `ping`, `pty_resize`, `pty_input`).

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

use crate::http::{is_allowed_loopback_origin, HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;

/// Validates WebSocket upgrade headers and prepares an upgrade response for `/ws`.
pub fn prepare_websocket_upgrade(state: Arc<StudioState>, req: HttpRequest) -> HttpResponse {
    let is_ws = req
        .header("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let Some(ws_key) = req.header("sec-websocket-key").map(str::trim) else {
        return HttpResponse::error(
            400,
            "missing_websocket_key",
            "WebSocket upgrade requires Sec-WebSocket-Key header.",
        );
    };
    if !is_ws || ws_key.is_empty() {
        return HttpResponse::error(
            400,
            "invalid_websocket_upgrade",
            "Expected Upgrade: websocket request.",
        );
    }

    let accept_key = derive_accept_key(ws_key.as_bytes());
    let origin = req
        .header("origin")
        .map(str::trim)
        .filter(|o| !o.is_empty() && is_allowed_loopback_origin(o))
        .map(ToString::to_string);
    let pinned_pty = req.query_param("ptyId").or_else(|| req.query_param("id"));
    let channels_param = req.query_param("channel").or_else(|| req.query_param("channels"));

    HttpResponse::websocket(Box::new(move |stream| {
        Box::pin(async move {
            serve_websocket(stream, state, accept_key, origin, pinned_pty, channels_param).await;
        })
    }))
}

async fn serve_websocket(
    mut stream: TcpStream,
    state: Arc<StudioState>,
    accept_key: String,
    origin: Option<String>,
    pinned_pty: Option<String>,
    channels_param: Option<String>,
) {
    let mut head = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept_key}\r\n"
    );
    if let Some(org) = origin {
        head.push_str(&format!("Access-Control-Allow-Origin: {org}\r\nVary: Origin\r\n"));
    }
    head.push_str("\r\n");

    if stream.write_all(head.as_bytes()).await.is_err() || stream.flush().await.is_err() {
        return;
    }

    let ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut ws_tx, mut ws_rx) = ws.split();

    let mut allowed_channels: HashSet<String> = channels_param
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty() && s != "all")
        .collect();

    let mut feed_rx = state.event_feed.subscribe_ws();
    let mut dl_rx = state.downloads.subscribe_events();
    let mut active_pty = pinned_pty.clone();
    let mut pty_rx = active_pty
        .as_deref()
        .and_then(|id| state.terminals.subscribe(id).ok());

    let hello = json!({
        "channel": "system",
        "event": "ws_connected",
        "seq": state.event_feed.head_seq(),
        "payload": {
            "server": "omnia-studio",
            "pinnedPtyId": active_pty,
            "channels": ["agent", "pty", "swarm", "downloads", "browser", "workspace", "router", "mcp", "network", "telemetry", "alerts", "research", "think", "lifecycle"],
        }
    });
    if ws_tx
        .send(WsMessage::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            ev_res = feed_rx.recv() => {
                match ev_res {
                    Ok(ev) => {
                        if !allowed_channels.is_empty()
                            && !allowed_channels.contains(&ev.channel.to_ascii_lowercase())
                        {
                            continue;
                        }
                        let msg = json!({
                            "channel": ev.channel,
                            "event": ev.event,
                            "seq": ev.seq,
                            "sessionId": ev.session_id,
                            "payload": ev.payload,
                            "timestampMs": ev.timestamp_ms,
                        });
                        if ws_tx.send(WsMessage::Text(msg.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            dl_res = dl_rx.recv() => {
                match dl_res {
                    Ok(dl_ev) => {
                        if !allowed_channels.is_empty() && !allowed_channels.contains("downloads") {
                            continue;
                        }
                        if let Ok(payload) = serde_json::to_value(&dl_ev) {
                            let msg = json!({
                                "channel": "downloads",
                                "event": "download_progress",
                                "seq": state.event_feed.head_seq(),
                                "payload": payload,
                            });
                            if ws_tx.send(WsMessage::Text(msg.to_string().into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                }
            }
            Some(pty_chunk) = async {
                match pty_rx.as_mut() {
                    Some(rx) => rx.recv().await.ok(),
                    None => std::future::pending::<Option<Vec<u8>>>().await,
                }
            } => {
                let mut frame = Vec::with_capacity(1 + pty_chunk.len());
                frame.push(0x01u8);
                frame.extend_from_slice(&pty_chunk);
                if ws_tx.send(WsMessage::Binary(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = ws_rx.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(txt))) => {
                        if let Ok(cmd) = serde_json::from_str::<Value>(&txt) {
                            let kind = cmd.get("type").or_else(|| cmd.get("event")).and_then(Value::as_str).unwrap_or("");
                            match kind {
                                "ping" => {
                                    let pong = json!({ "channel": "system", "event": "pong", "seq": state.event_feed.head_seq() });
                                    if ws_tx.send(WsMessage::Text(pong.to_string().into())).await.is_err() {
                                        break;
                                    }
                                }
                                "subscribe" => {
                                    if let Some(arr) = cmd.get("channels").and_then(Value::as_array) {
                                        allowed_channels = arr
                                            .iter()
                                            .filter_map(Value::as_str)
                                            .map(|s| s.trim().to_ascii_lowercase())
                                            .filter(|s| !s.is_empty() && s != "all")
                                            .collect();
                                    }
                                    if let Some(pid) = cmd.get("ptyId").and_then(Value::as_str) {
                                        active_pty = Some(pid.to_string());
                                        pty_rx = state.terminals.subscribe(pid).ok();
                                    }
                                }
                                "pty_input" => {
                                    let pid = cmd.get("ptyId").and_then(Value::as_str).or(active_pty.as_deref());
                                    if let (Some(id), Some(data)) = (pid, cmd.get("data").and_then(Value::as_str)) {
                                        let _ = state.terminals.write_input(id, data.as_bytes().to_vec()).await;
                                    }
                                }
                                "pty_resize" => {
                                    let pid = cmd.get("ptyId").and_then(Value::as_str).or(active_pty.as_deref());
                                    let cols = cmd.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16;
                                    let rows = cmd.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16;
                                    if let Some(id) = pid {
                                        let _ = state.terminals.resize(id, cols, rows);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(WsMessage::Binary(bin))) => {
                        if let Some(ref pid) = active_pty {
                            let payload = if bin.first() == Some(&0x00) {
                                bin[1..].to_vec()
                            } else {
                                bin.to_vec()
                            };
                            let _ = state.terminals.write_input(pid, payload).await;
                        } else if bin.len() >= 2 && bin[0] == 0x00 {
                            let id_len = usize::from(bin[1]);
                            if bin.len() >= 2 + id_len {
                                if let Ok(id) = std::str::from_utf8(&bin[2..2 + id_len]) {
                                    let _ = state.terminals.write_input(id, bin[2 + id_len..].to_vec()).await;
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(p))) => {
                        if ws_tx.send(WsMessage::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}
