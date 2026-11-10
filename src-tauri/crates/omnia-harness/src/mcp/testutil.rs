//! In-process fake MCP server for tests, speaking newline-delimited JSON-RPC
//! over `tokio::io::duplex`.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
use tokio::task::JoinHandle;

pub(crate) struct FakeServer {
    log: Arc<Mutex<Vec<Value>>>,
    handle: JoinHandle<()>,
}

impl FakeServer {
    /// Every message the server received, in order.
    pub(crate) fn log(&self) -> Vec<Value> {
        self.log.lock().unwrap().clone()
    }

    pub(crate) fn stop(&self) {
        self.handle.abort();
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Returns (client reader, client writer, server handle).
pub(crate) fn spawn_fake() -> (DuplexStream, DuplexStream, FakeServer) {
    let (client_reader, server_writer) = tokio::io::duplex(1 << 16);
    let (server_reader, client_writer) = tokio::io::duplex(1 << 16);
    let log = Arc::new(Mutex::new(Vec::new()));
    let handle = tokio::spawn(serve(server_reader, server_writer, log.clone()));
    (client_reader, client_writer, FakeServer { log, handle })
}

async fn send(w: &mut DuplexStream, v: Value) {
    let mut line = serde_json::to_vec(&v).unwrap();
    line.push(b'\n');
    w.write_all(&line).await.unwrap();
    w.flush().await.unwrap();
}

fn tool(name: &str, extra: Value) -> Value {
    let mut t = json!({"name": name, "description": format!("{name} tool")});
    if let (Some(obj), Some(more)) = (t.as_object_mut(), extra.as_object()) {
        obj.extend(more.clone());
    }
    t
}

async fn serve(reader: DuplexStream, mut w: DuplexStream, log: Arc<Mutex<Vec<Value>>>) {
    let mut lines = BufReader::new(reader).lines();
    let mut waiting_ping: Option<Value> = None;
    let (mut got_p1, mut got_u1) = (false, false);
    while let Ok(Some(line)) = lines.next_line().await {
        let msg: Value = serde_json::from_str(&line).unwrap();
        log.lock().unwrap().push(msg.clone());
        let id = msg.get("id").cloned();
        match (msg["method"].as_str(), id) {
            (Some("initialize"), Some(id)) => {
                send(
                    &mut w,
                    json!({"jsonrpc":"2.0","id":id,"result":{
                        "protocolVersion":"2099-01-01",
                        "capabilities":{"tools":{}},
                        "serverInfo":{"name":"fake","version":"1"}}}),
                )
                .await;
            }
            (Some("tools/list"), Some(id)) => {
                let result = if msg["params"]["cursor"] == "page2" {
                    json!({"tools":[
                        tool("slow", json!({"inputSchema":{"type":"object"}})),
                        tool("ping_first", json!({})),
                        tool("ro", json!({"annotations":{"readOnlyHint":true}})),
                    ]})
                } else {
                    json!({"tools":[
                        tool("echo", json!({})),
                        tool("img", json!({})),
                        tool("err", json!({})),
                    ], "nextCursor":"page2"})
                };
                send(&mut w, json!({"jsonrpc":"2.0","id":id,"result":result})).await;
            }
            (Some("tools/call"), Some(id)) => match msg["params"]["name"].as_str() {
                Some("echo") => {
                    let text = format!("echo:{}", msg["params"]["arguments"]["text"]);
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":text}]}}),
                    )
                    .await;
                }
                Some("img") => {
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","id":id,"result":{"content":[
                            {"type":"image","data":"QUJD","mimeType":"image/png"}]}}),
                    )
                    .await;
                }
                Some("err") => {
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","id":id,"result":{"isError":true,
                            "content":[{"type":"text","text":"boom"}]}}),
                    )
                    .await;
                }
                Some("changed") => {
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"}),
                    )
                    .await;
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","id":id,"result":{"content":[]}}),
                    )
                    .await;
                }
                Some("ping_first") => {
                    waiting_ping = Some(id);
                    send(&mut w, json!({"jsonrpc":"2.0","id":"p1","method":"ping"})).await;
                    send(
                        &mut w,
                        json!({"jsonrpc":"2.0","id":"u1","method":"foo/bar"}),
                    )
                    .await;
                }
                // "slow" and unknown tools never answer.
                _ => {}
            },
            (None, Some(id)) => {
                if id == "p1" {
                    got_p1 = true;
                }
                if id == "u1" {
                    got_u1 = true;
                }
                if got_p1 && got_u1 {
                    if let Some(call_id) = waiting_ping.take() {
                        send(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":call_id,"result":{
                                "content":[{"type":"text","text":"pong-ok"}]}}),
                        )
                        .await;
                    }
                }
            }
            _ => {}
        }
    }
}
