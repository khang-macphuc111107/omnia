//! ByteDance Trae-inspired Append-Only JSONL Trajectory Recorder (`trajectory.jsonl`).

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryEvent {
    pub timestamp_ms: i64,
    pub session_key: String,
    pub turn: u32,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct TrajectoryRecorder {
    session_key: String,
    out_path: Option<PathBuf>,
    events: Arc<Mutex<Vec<TrajectoryEvent>>>,
}

impl TrajectoryRecorder {
    pub fn new(session_key: impl Into<String>, out_path: Option<PathBuf>) -> Self {
        if let Some(ref p) = out_path {
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
        }
        Self {
            session_key: session_key.into(),
            out_path,
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn record(&self, turn: u32, kind: &str, payload: Value) {
        let ev = TrajectoryEvent {
            timestamp_ms: Utc::now().timestamp_millis(),
            session_key: self.session_key.clone(),
            turn,
            kind: kind.to_string(),
            payload,
        };
        if let Some(ref path) = self.out_path {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                if let Ok(line) = serde_json::to_string(&ev) {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
        let mut guard = self.events.lock().unwrap();
        if guard.len() >= 1000 {
            guard.remove(0);
        }
        guard.push(ev);
    }

    pub fn record_tool_call(&self, turn: u32, tool_name: &str, is_error: bool, duration_ms: u64) {
        self.record(
            turn,
            "tool_result",
            json!({
                "tool": tool_name,
                "isError": is_error,
                "durationMs": duration_ms,
            }),
        );
    }

    pub fn snapshot(&self) -> Vec<TrajectoryEvent> {
        self.events.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_append_only_trajectory_jsonl() {
        let tmp = std::env::temp_dir().join(format!(
            "omni_traj_test_{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let rec = TrajectoryRecorder::new("sess-1", Some(tmp.clone()));
        rec.record(1, "turn_start", json!({ "model": "gemini-3.8-flash" }));
        rec.record_tool_call(1, "workspace_map", false, 3);
        let text = fs::read_to_string(&tmp).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"turn_start\""));
        assert!(lines[1].contains("\"workspace_map\""));
        let _ = fs::remove_file(&tmp);
    }
}
