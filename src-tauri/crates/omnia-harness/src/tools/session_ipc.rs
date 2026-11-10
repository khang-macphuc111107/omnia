//! Cross-session IPC tools for inter-agent communication and multi-model debate (Orca style).

use std::fs;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::tools::{finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

pub const DEFAULT_PIPE_NAME: &str = r"\\\\.\\pipe\\omnia-session-bridge";

fn sessions_dir(cwd: &Path) -> PathBuf {
    cwd.join(".omnia").join("sessions")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetadata {
    pub id: String,
    pub title: String,
    pub model: String,
    pub status: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossSessionPacket {
    pub id: String,
    pub from_session: String,
    pub to_session: String,
    pub mode: String,
    pub content: String,
    pub timestamp: u64,
}

impl CrossSessionPacket {
    pub fn to_wire_xml(&self) -> String {
        format!(
            "<cross-session-message id=\"{}\" from=\"{}\" to=\"{}\" mode=\"{}\" timestamp=\"{}\">\n{}\n</cross-session-message>",
            self.id, self.from_session, self.to_session, self.mode, self.timestamp, self.content
        )
    }
}

pub struct SessionListTool;

#[async_trait]
impl Tool for SessionListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "session_list".into(),
            description: "List discoverable active Omnia sessions and peer agents on the host."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "include_details": {"type": "boolean", "description": "Whether to return full metadata."}
                },
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, _: &Value) -> String {
        "List active sessions".to_string()
    }

    async fn call(&self, ctx: &ToolContext, _input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let dir = sessions_dir(&ctx.cwd);
            if !dir.exists() {
                return Ok(ToolOutput::text(
                    "No active sessions discovered (sessions directory not initialized).",
                ));
            }
            let mut sessions = Vec::new();
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let id = entry.file_name().to_string_lossy().to_string();
                        let meta_file = path.join("session.json");
                        if let Ok(content) = fs::read_to_string(&meta_file) {
                            if let Ok(meta) = serde_json::from_str::<SessionMetadata>(&content) {
                                sessions.push(meta);
                                continue;
                            }
                        }
                        sessions.push(SessionMetadata {
                            id,
                            title: "Untitled Session".to_string(),
                            model: "unknown".to_string(),
                            status: "active".to_string(),
                            updated_at: 0,
                        });
                    }
                }
            }
            if sessions.is_empty() {
                Ok(ToolOutput::text(
                    "No peer sessions found in this workspace.",
                ))
            } else {
                Ok(ToolOutput::text(
                    serde_json::to_string_pretty(&sessions).unwrap_or_default(),
                ))
            }
        })())
    }
}

#[derive(Deserialize)]
struct SendArgs {
    target_session_id: String,
    message: String,
    #[serde(default = "default_mode")]
    mode: String,
}

fn default_mode() -> String {
    "steer".to_string()
}

pub struct SessionSendTool;

#[async_trait]
impl Tool for SessionSendTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "session_send".into(),
            description: "Send a cross-session message, prompt, or Orca consensus critique to another session.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "target_session_id": {"type": "string", "description": "Target session ID."},
                    "message": {"type": "string", "description": "Message content or critique."},
                    "mode": {"type": "string", "enum": ["steer", "review", "inquiry"], "description": "Intent of message (default steer)."}
                },
                "required": ["target_session_id", "message"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Send cross-session message to {}",
            input["target_session_id"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: SendArgs = parse_input(input)?;
            let target_dir = sessions_dir(&ctx.cwd).join(&args.target_session_id);
            fs::create_dir_all(&target_dir)
                .map_err(|e| format!("cannot create session directory: {e}"))?;

            let packet = CrossSessionPacket {
                id: uuid::Uuid::new_v4().to_string(),
                from_session: ctx.tool_use_id.clone(),
                to_session: args.target_session_id.clone(),
                mode: args.mode,
                content: args.message,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            };

            let inbox_file = target_dir.join("inbox.jsonl");
            ctx.checkpoint_before(&inbox_file)?;
            let serialized =
                serde_json::to_string(&packet).map_err(|e| format!("serialization error: {e}"))?;

            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&inbox_file)
                .map_err(|e| format!("cannot open inbox.jsonl: {e}"))?;
            writeln!(file, "{}", serialized).map_err(|e| format!("cannot write message: {e}"))?;

            Ok(ToolOutput::text(format!(
                "Delivered message [{}] to session `{}` via cross-session bridge.\nWire framing:\n{}",
                packet.id, args.target_session_id, packet.to_wire_xml()
            )))
        })())
    }
}

#[derive(Deserialize)]
struct ReadSessionArgs {
    session_id: String,
    #[serde(default)]
    drain: bool,
}

pub struct SessionReadTool;

#[async_trait]
impl Tool for SessionReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "session_read".into(),
            description: "Read incoming cross-session messages from another session's mailbox."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session ID whose mailbox to read."},
                    "drain": {"type": "boolean", "description": "Whether to clear read messages from inbox."}
                },
                "required": ["session_id"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Read mailbox for session {}",
            input["session_id"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: ReadSessionArgs = parse_input(input)?;
            let inbox_file = sessions_dir(&ctx.cwd)
                .join(&args.session_id)
                .join("inbox.jsonl");
            if !inbox_file.is_file() {
                return Ok(ToolOutput::text("Mailbox is empty (no incoming messages)."));
            }
            let content =
                fs::read_to_string(&inbox_file).map_err(|e| format!("cannot read inbox: {e}"))?;
            if content.trim().is_empty() {
                return Ok(ToolOutput::text("Mailbox is empty (no incoming messages)."));
            }
            let mut packets = Vec::new();
            for line in content.lines() {
                if let Ok(pkt) = serde_json::from_str::<CrossSessionPacket>(line) {
                    packets.push(pkt);
                }
            }
            if args.drain {
                ctx.checkpoint_before(&inbox_file)?;
                let _ = fs::write(&inbox_file, "");
            }
            Ok(ToolOutput::text(
                serde_json::to_string_pretty(&packets).unwrap_or_default(),
            ))
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Setup = (tempfile::TempDir, ToolContext);

    fn setup() -> Setup {
        let cwd = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(cwd.path());
        (cwd, ctx)
    }

    #[tokio::test]
    async fn cross_session_send_and_read_roundtrip() {
        let (_cwd, mut ctx) = setup();
        ctx.tool_use_id = "session-alpha".to_string();

        let send_tool = SessionSendTool;
        let read_tool = SessionReadTool;

        let send_input = json!({
            "target_session_id": "session-beta",
            "message": "Please review AST index logic",
            "mode": "review"
        });

        let send_out = send_tool.call(&ctx, send_input).await.unwrap();
        assert!(!send_out.is_error);
        let send_text = format!("{:?}", send_out.content);
        assert!(send_text.contains("<cross-session-message"));
        assert!(send_text.contains("Please review AST index logic"));

        let read_input = json!({
            "session_id": "session-beta",
            "drain": false
        });
        let read_out = read_tool.call(&ctx, read_input).await.unwrap();
        assert!(!read_out.is_error);
        let read_text = format!("{:?}", read_out.content);
        assert!(read_text.contains("session-beta"));
        assert!(read_text.contains("session-alpha"));
        assert!(read_text.contains("Please review AST index logic"));

        // Test draining
        let drain_input = json!({
            "session_id": "session-beta",
            "drain": true
        });
        let _ = read_tool.call(&ctx, drain_input).await.unwrap();

        // Read again should be empty
        let empty_out = read_tool
            .call(&ctx, json!({"session_id": "session-beta"}))
            .await
            .unwrap();
        let empty_text = format!("{:?}", empty_out.content);
        assert!(empty_text.contains("Mailbox is empty"));
    }
}
