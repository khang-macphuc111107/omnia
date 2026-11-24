//! Private, single-writer ACP checkpoints. No endpoint, permissions or runtime is serialized.
use crate::{redact_secrets, HarnessMessage, NativeSuperEngine};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u8,
    session_id: Uuid,
    model: String,
    workspace: PathBuf,
    turns: u32,
    messages: Vec<HarnessMessage>,
    updates: Vec<(u32, Value)>,
}

/// Keep the OS lock alive until the last reference to the live session drops.
pub(crate) struct Journal {
    _lease: File,
    id: Uuid,
    path: PathBuf,
    updates: Vec<(u32, Value)>,
    resumable: bool,
    saved: Option<Snapshot>,
    // The transcript cannot certify the separate optional filesystem undo journal.
    rewind_floor: u32,
}

#[cfg(test)]
#[test]
fn acp_checkpoint_rejects_orphan_duplicate_and_unfinished_tool_history() {
    use crate::ToolCallRecord;
    let call = ToolCallRecord {
        id: "call".into(),
        name: "read_file".into(),
        arguments: "{}".into(),
    };
    let assistant = HarnessMessage::assistant("", None, vec![call.clone()], 1);
    let tool = HarnessMessage::tool_result("call", "read_file", "result", 1);
    assert!(validate_messages(std::slice::from_ref(&assistant), &[]).is_err());
    assert!(validate_messages(std::slice::from_ref(&tool), &[]).is_err());
    assert!(validate_messages(
        &[
            assistant.clone(),
            HarnessMessage::tool_result("call", "shell", "wrong", 1)
        ],
        &[]
    )
    .is_err());
    assert!(validate_messages(
        &[
            HarnessMessage::assistant("", None, vec![call.clone(), call], 1),
            tool.clone()
        ],
        &[]
    )
    .is_err());
    assert!(validate_messages(&[assistant, tool], &[]).is_ok());
}

#[cfg(test)]
#[test]
fn acp_checkpoint_refuses_workspace_storage_and_invalid_ids_before_creating_files() {
    let tmp = std::env::temp_dir().join(format!("acp-storage-{}", Uuid::new_v4()));
    let workspace = tmp.join("workspace");
    let other_repo = tmp.join("other-checkout");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(other_repo.join(".git")).unwrap();
    let sid = format!("acp-{}", Uuid::new_v4());
    for path in [workspace.join("history"), other_repo.join("history")] {
        assert!(Journal::open(&path, &workspace, &sid, true).is_err());
        assert!(!path.exists());
    }
    let private = tmp.join("history");
    for invalid in [
        "../outside",
        "acp-../../outside",
        "acp-00000000-0000-0000-0000-000000000000",
    ] {
        assert!(Journal::open(&private, &workspace, invalid, true).is_err());
        assert!(!private.exists());
    }
    fs::remove_dir_all(tmp).unwrap();
}

#[cfg(test)]
#[test]
fn acp_checkpoint_rejects_credentials_in_object_keys_and_http_headers() {
    let secret = "opaque-runtime-credential";
    assert!(!credential_free(
        &json!({"metadata":{(secret):true}}),
        &[secret]
    ));
    assert!(!credential_free(
        &json!({"headers":{"X-API-Key":"opaque-header"}}),
        &[]
    ));
    assert!(!credential_free(
        &json!({"headers":{"Cookie":"session=opaque"}}),
        &[]
    ));
    assert!(credential_free(
        &json!({"headers":{"Content-Type":"text/plain"}}),
        &[secret]
    ));
}

#[cfg(test)]
#[test]
fn acp_checkpoint_rejects_snapshot_copied_between_session_ids() {
    let tmp = std::env::temp_dir().join(format!("acp-swap-{}", Uuid::new_v4()));
    let cwd = tmp.join("workspace");
    let store = tmp.join("history");
    fs::create_dir_all(&cwd).unwrap();
    let id = Uuid::new_v4();
    let sid = format!("acp-{id}");
    let journal = Journal::open(&store, &cwd, &sid, true).unwrap();
    let swapped = Snapshot {
        version: 1,
        session_id: Uuid::new_v4(),
        workspace: cwd.canonicalize().unwrap(),
        model: "example/offline".into(),
        turns: 0,
        messages: vec![],
        updates: vec![],
    };
    journal
        .replace(&serde_json::to_vec(&swapped).unwrap())
        .unwrap();
    drop(journal);
    assert!(Journal::open(&store, &cwd, &sid, false).is_err());
    fs::remove_dir_all(tmp).unwrap();
}

#[cfg(test)]
#[test]
fn acp_checkpoint_rejects_corrupt_versions_and_credential_bearing_replay() {
    let tmp = std::env::temp_dir().join(format!("acp-corrupt-{}", Uuid::new_v4()));
    let cwd = tmp.join("workspace");
    let store = tmp.join("history");
    fs::create_dir_all(&cwd).unwrap();
    let id = Uuid::new_v4();
    let sid = format!("acp-{id}");
    let journal = Journal::open(&store, &cwd, &sid, true).unwrap();
    let mut snapshot = Snapshot {
        version: 99,
        session_id: id,
        workspace: cwd.canonicalize().unwrap(),
        model: "example/offline".into(),
        turns: 0,
        messages: vec![],
        updates: vec![],
    };
    journal
        .replace(&serde_json::to_vec(&snapshot).unwrap())
        .unwrap();
    drop(journal);
    assert!(Journal::open(&store, &cwd, &sid, false).is_err());
    // Verify a supported envelope loads, then put a secret only in its replay stream.
    snapshot.version = 1;
    let path = store.join(format!("{id}.json"));
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let resumed = Journal::open(&store, &cwd, &sid, false).unwrap();
    resumed.begin_turn().unwrap();
    drop(resumed); // Interrupted before save: the previous complete turn must not resurface.
    assert!(Journal::open(&store, &cwd, &sid, false).is_err());
    snapshot.updates.push((
        0,
        json!({"sessionUpdate":"tool_call", "rawInput":{"authorization":"opaque"}}),
    ));
    fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(Journal::open(&store, &cwd, &sid, false).is_err());
    fs::write(&path, br#"{"version":1"#).unwrap();
    assert!(Journal::open(&store, &cwd, &sid, false).is_err());
    fs::remove_dir_all(tmp).unwrap();
}

fn private_file() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts
}

pub(crate) fn default_root() -> Option<PathBuf> {
    // Never fall back to the cwd, a shared temp dir, or workspace-controlled OMNIA_HOME.
    dirs::data_local_dir()
        .filter(|p| p.is_absolute())
        .map(|p| p.join("omnia-acp-sessions"))
}

fn ensure_private_dir(path: &Path, cwd: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute() && !path.starts_with(cwd),
        "unsafe ACP history directory"
    );
    let parent = path.parent().context("invalid ACP history directory")?;
    ensure!(
        !parent.ancestors().any(|p| p.join(".git").exists()),
        "history directory inside repository"
    );
    fs::create_dir_all(parent)?;
    ensure!(
        !parent.canonicalize()?.starts_with(cwd.canonicalize()?),
        "history directory inside workspace"
    );
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    if let Err(e) = builder.create(path) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(e.into());
        }
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(meta.file_type().is_dir(), "unsafe ACP history directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "history directory is not private"
        );
    }
    let resolved = path.canonicalize()?;
    ensure!(
        !resolved.ancestors().any(|p| p.join(".git").exists()),
        "history directory inside repository"
    );
    ensure!(
        !resolved.starts_with(cwd.canonicalize()?),
        "history directory inside workspace"
    );
    Ok(resolved)
}

fn validate_messages(messages: &[HarnessMessage], secrets: &[&str]) -> Result<()> {
    let mut pending = HashMap::new();
    for m in messages {
        match m.role.as_str() {
            "assistant" if pending.is_empty() => {
                for call in &m.tool_calls {
                    ensure!(
                        !call.id.is_empty() && pending.insert(&call.id, &call.name).is_none(),
                        "invalid tool call ID"
                    );
                    let input = serde_json::from_str::<Value>(&call.arguments)
                        .context("invalid tool arguments")?;
                    ensure!(
                        credential_free(&input, secrets),
                        "tool input contains credential fields"
                    );
                }
            }
            "tool" => {
                let name = m.tool_call_id.as_ref().and_then(|id| pending.remove(id));
                ensure!(
                    name.is_some() && name == m.tool_name.as_ref(),
                    "unmatched tool result"
                );
            }
            "user" if pending.is_empty() => (),
            _ => bail!("incomplete or unsupported model history"),
        }
    }
    ensure!(pending.is_empty(), "incomplete tool history");
    Ok(())
}

// Reject rather than rewrite: redacting serialized JSON can break arguments, IDs or signatures.
fn credential_free_text(text: &str, secrets: &[&str]) -> bool {
    !secrets.iter().any(|k| !k.is_empty() && text.contains(*k)) && redact_secrets(text) == text
}

fn credential_free(v: &Value, secrets: &[&str]) -> bool {
    match v {
        Value::String(s) => credential_free_text(s, secrets),
        Value::Array(a) => a.iter().all(|v| credential_free(v, secrets)),
        Value::Object(o) => o.iter().all(|(k, v)| {
            credential_free_text(k, secrets)
                && !matches!(
                    k.to_ascii_lowercase().as_str(),
                    "authorization"
                        | "password"
                        | "api_key"
                        | "apikey"
                        | "access_token"
                        | "refresh_token"
                        | "private_key"
                        | "x-api-key"
                        | "x-secret-key"
                        | "proxy-authorization"
                        | "client_secret"
                        | "cookie"
                        | "set-cookie"
                )
                && credential_free(v, secrets)
        }),
        _ => true,
    }
}

impl Journal {
    pub(crate) fn open(root: &Path, cwd: &Path, sid: &str, new: bool) -> Result<Self> {
        let id = sid
            .strip_prefix("acp-")
            .and_then(|s| Uuid::parse_str(s).ok())
            .context("invalid session ID")?;
        ensure!(
            sid == format!("acp-{id}") && id.get_version_num() == 4,
            "invalid session ID"
        );
        let root = ensure_private_dir(root, cwd)?;
        let lease = private_file()
            .create_new(new)
            .open(root.join(format!("{id}.lock")))?;
        lease.try_lock().context("session already active")?;
        let path = root.join(format!("{id}.json"));
        let saved = if new {
            None
        } else {
            let snapshot: Snapshot = serde_json::from_reader(File::open(&path)?)?;
            ensure!(
                snapshot.version == 1
                    && snapshot.session_id == id
                    && snapshot.workspace == cwd.canonicalize()?,
                "invalid session or workspace"
            );
            validate_messages(&snapshot.messages, &[])?;
            ensure!(
                credential_free(&serde_json::to_value(&snapshot.messages)?, &[]),
                "history contains credential fields"
            );
            ensure!(
                snapshot
                    .updates
                    .iter()
                    .all(|(_, update)| credential_free(update, &[])),
                "history contains credential updates"
            );
            Some(snapshot)
        };
        Ok(Self {
            _lease: lease,
            id,
            rewind_floor: saved.as_ref().map_or(0, |s| s.turns),
            saved,
            path,
            updates: Vec::new(),
            resumable: true,
        })
    }

    pub(crate) fn can_rewind_to(&self, target: u32) -> bool {
        target >= self.rewind_floor
    }

    pub(crate) fn saved_model(&self) -> Option<&str> {
        self.saved.as_ref().map(|s| s.model.as_str())
    }

    fn replace(&self, bytes: &[u8]) -> Result<()> {
        let tmp = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut file = private_file().create_new(true).open(&tmp)?;
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &self.path)?;
            #[cfg(unix)]
            File::open(self.path.parent().unwrap())?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result
    }

    pub(crate) fn begin_turn(&self) -> Result<()> {
        // A crash after a tool side effect must not resurrect a stale pre-tool checkpoint.
        ensure!(self.resumable, "previous checkpoint failed");
        self.replace(br#"{"incomplete":true}"#)
    }

    pub(crate) fn save(
        &mut self,
        eng: &NativeSuperEngine,
        new_messages: usize,
        blocks: &[Value],
        secrets: &[&str],
    ) -> Result<()> {
        ensure!(self.resumable, "previous checkpoint failed");
        let result = self.save_turn(eng, new_messages, blocks, secrets);
        if result.is_err() {
            self.resumable = false;
        }
        result
    }

    fn save_turn(
        &mut self,
        eng: &NativeSuperEngine,
        new_messages: usize,
        blocks: &[Value],
        secrets: &[&str],
    ) -> Result<()> {
        let messages = &eng.messages[1..];
        validate_messages(messages, secrets)?;
        let user_turn = eng
            .messages
            .get(new_messages)
            .map_or(eng.total_turns, |m| m.turn_index);
        for block in blocks {
            self.updates.push((
                user_turn,
                json!({"sessionUpdate":"user_message_chunk", "content":block}),
            ));
        }
        for m in &eng.messages[new_messages..] {
            if m.role == "assistant" {
                if let Some(reason) = &m.reasoning {
                    if !reason.is_empty() {
                        self.updates.push((m.turn_index, json!({"sessionUpdate":"agent_thought_chunk", "content":{"type":"text", "text":reason}})));
                    }
                }
                if !m.content.is_empty() {
                    self.updates.push((m.turn_index, json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":m.content}})));
                }
                for call in &m.tool_calls {
                    let input: Value = serde_json::from_str(&call.arguments)?;
                    self.updates.push((m.turn_index, json!({"sessionUpdate":"tool_call", "toolCallId":call.id,"title":call.name,"status":"in_progress","rawInput":input})));
                }
            } else if m.role == "tool" {
                self.updates.push((m.turn_index, json!({"sessionUpdate":"tool_call_update", "toolCallId":m.tool_call_id,"status":if m.tool_is_error { "failed" } else { "completed" },"content":[{"type":"content","content":{"type":"text","text":m.content}}]})));
            }
        }
        let record = json!({"version":1,"session_id":self.id,"model":format!("{}/{}",eng.endpoint.provider_id,eng.endpoint.model_id),"workspace":eng.workspace_root.canonicalize()?,"turns":eng.total_turns,"messages":messages,"updates":self.updates});
        ensure!(
            credential_free(&record, secrets),
            "history contains recognized credential material"
        );
        self.replace(&serde_json::to_vec(&record)?)
    }

    pub(crate) fn rewind(
        &mut self,
        eng: &NativeSuperEngine,
        target: u32,
        secrets: &[&str],
    ) -> Result<()> {
        self.updates.retain(|(turn, _)| *turn <= target);
        self.save(eng, eng.messages.len(), &[], secrets)
    }

    pub(crate) fn restore(&mut self, eng: &mut NativeSuperEngine) -> Result<&[(u32, Value)]> {
        let snapshot = self.saved.take().context("no saved conversation")?;
        eng.restore_acp_history(snapshot.turns, snapshot.messages);
        self.updates = snapshot.updates;
        Ok(&self.updates)
    }
}
