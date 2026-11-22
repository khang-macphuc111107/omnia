use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread::{self, JoinHandle};

use omnia_core::{now_epoch_ms, uuid_v4};
use omnia_storage::{
    AgentSessionPage, AgentSessionSummary, CreateAgentSessionRequest, HarnessEnvironment,
    HarnessStore, Sessions, SessionsSnapshot, StoreError, UpdateAgentSessionSettingsRequest,
    DEFAULT_TOKEN_BUDGET,
};
use omnia_winsqlite::{Connection, StepStatus};

use crate::types::{
    normalize_effort, validate_session_settings_input, NativeSessionsSnapshot,
    NativeUiSessionSummary, UNCONFIGURED_MODEL_SENTINEL,
};

/// Maximum number of concurrent in-flight storage operations permitted by [`NativeSessionWorker`].
pub const MAX_PENDING_SESSION_COMMANDS: usize = 1;

const NATIVE_META_DDL: &str = "
CREATE TABLE IF NOT EXISTS native_session_meta (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    model_unconfigured INTEGER NOT NULL DEFAULT 0,
    reasoning_effort TEXT NOT NULL DEFAULT 'medium'
);
";

#[derive(Debug, Clone)]
struct NativeMetaRow {
    model_unconfigured: bool,
    reasoning_effort: String,
}

impl Default for NativeMetaRow {
    fn default() -> Self {
        Self {
            model_unconfigured: false,
            reasoning_effort: "medium".to_owned(),
        }
    }
}

fn ensure_native_meta_table(conn: &Connection) -> Result<(), StoreError> {
    conn.exec_batch(NATIVE_META_DDL)?;
    Ok(())
}

fn upsert_native_meta(
    conn: &Connection,
    session_id: &str,
    model_unconfigured: bool,
    effort: &str,
) -> Result<(), StoreError> {
    let norm_effort = normalize_effort(effort).unwrap_or("medium");
    let mut stmt = conn.prepare(
        "INSERT INTO native_session_meta (session_id, model_unconfigured, reasoning_effort)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET
             model_unconfigured = excluded.model_unconfigured,
             reasoning_effort = excluded.reasoning_effort;",
    )?;
    stmt.bind_text(1, session_id)?;
    stmt.bind_int64(2, if model_unconfigured { 1 } else { 0 })?;
    stmt.bind_text(3, norm_effort)?;
    let _ = stmt.step()?;
    Ok(())
}

fn read_native_meta(conn: &Connection, session_id: &str) -> Result<NativeMetaRow, StoreError> {
    let mut stmt = conn.prepare(
        "SELECT model_unconfigured, reasoning_effort
         FROM native_session_meta
         WHERE session_id = ?1;",
    )?;
    stmt.bind_text(1, session_id)?;
    if stmt.step()? == StepStatus::Row {
        let model_unconfigured = stmt.column_int64(0)? != 0;
        let effort = stmt
            .column_opt_text(1)?
            .and_then(|v| normalize_effort(&v))
            .unwrap_or("medium")
            .to_owned();
        return Ok(NativeMetaRow {
            model_unconfigured,
            reasoning_effort: effort,
        });
    }
    Ok(NativeMetaRow::default())
}

fn read_native_meta_batch(
    conn: &Connection,
    ids: &[&str],
) -> Result<HashMap<String, NativeMetaRow>, StoreError> {
    let mut map = HashMap::with_capacity(ids.len());
    for &id in ids {
        let meta = read_native_meta(conn, id)?;
        map.insert(id.to_owned(), meta);
    }
    Ok(map)
}

fn project_summary(summary: &AgentSessionSummary, meta: &NativeMetaRow) -> NativeUiSessionSummary {
    let ui_model = if meta.model_unconfigured || summary.model == UNCONFIGURED_MODEL_SENTINEL {
        String::new()
    } else {
        summary.model.clone()
    };
    NativeUiSessionSummary {
        id: summary.id.clone(),
        title: summary.title.clone(),
        ui_model,
        reasoning_effort: meta.reasoning_effort.clone(),
        updated_at_ms: summary.updated_at_ms,
        created_at_ms: summary.created_at_ms,
        revision: summary.revision,
        message_count: summary.message_count,
    }
}

fn project_snapshot(
    conn: &Connection,
    snap: SessionsSnapshot,
) -> Result<NativeSessionsSnapshot, StoreError> {
    let active_session = if let Some(ref active) = snap.active_session {
        let meta = read_native_meta(conn, &active.id)?;
        Some(project_summary(active, &meta))
    } else {
        None
    };

    // Normalize projected page items if any caller reads model from page items.
    let ids: Vec<&str> = snap.page.items.iter().map(|s| s.id.as_str()).collect();
    let metas = read_native_meta_batch(conn, &ids)?;
    let items = snap
        .page
        .items
        .into_iter()
        .map(|mut item| {
            if let Some(meta) = metas.get(&item.id) {
                if meta.model_unconfigured || item.model == UNCONFIGURED_MODEL_SENTINEL {
                    item.model.clear();
                }
            } else if item.model == UNCONFIGURED_MODEL_SENTINEL {
                item.model.clear();
            }
            item
        })
        .collect();

    Ok(NativeSessionsSnapshot {
        page: AgentSessionPage {
            items,
            next_cursor: snap.page.next_cursor,
            has_more: snap.page.has_more,
            total_count: snap.page.total_count,
        },
        active_session_id: snap.active_session_id,
        active_session,
        active_on_page: snap.active_on_page,
        page_limit: snap.page_limit,
        can_go_prev: snap.can_go_prev,
        can_go_next: snap.can_go_next,
        navigation_revision: snap.navigation_revision.unwrap_or(0),
    })
}

/// Synchronous Omnia native session store wrapping `omnia_storage::Sessions` plus
/// companion `native_session_meta` UI fields (`model_unconfigured`, `reasoning_effort`).
pub struct NativeSessionStore {
    sessions: Sessions,
}

impl NativeSessionStore {
    /// Open or create the durable SQLite store at `db_path` with exclusive [`omnia_winsqlite::StoreOwnership`].
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let sessions = Sessions::open(db_path)?;
        ensure_native_meta_table(sessions.store().connection())?;
        Ok(Self { sessions })
    }

    /// Open an isolated in-memory store for deterministic unit tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let sessions = Sessions::open_in_memory()?;
        ensure_native_meta_table(sessions.store().connection())?;
        Ok(Self { sessions })
    }

    /// Wrap an already-opened [`HarnessStore`].
    pub fn from_store(store: HarnessStore) -> Result<Self, StoreError> {
        let sessions = Sessions::from_store(store)?;
        ensure_native_meta_table(sessions.store().connection())?;
        Ok(Self { sessions })
    }

    /// Borrow underlying `omnia_storage::Sessions`.
    #[must_use]
    pub fn inner(&self) -> &Sessions {
        &self.sessions
    }

    /// Mutably borrow underlying `omnia_storage::Sessions`.
    #[must_use]
    pub fn inner_mut(&mut self) -> &mut Sessions {
        &mut self.sessions
    }

    /// Refresh current page and project the full native UI snapshot.
    pub fn refresh(&mut self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.sessions.refresh()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Jump back to page 1 (newest sessions) and refresh.
    pub fn first_page(&mut self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.sessions.first_page()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Advance to the next keyset cursor page.
    pub fn next_page(&mut self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.sessions.next_page()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Return to the previous keyset cursor page.
    pub fn prev_page(&mut self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.sessions.prev_page()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Return the current snapshot without re-querying paging cursors.
    pub fn snapshot(&self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.sessions.snapshot()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Create a new projectless session (`"New chat"`) with unset UI model (`""`) and `"medium"` effort.
    pub fn create_projectless_session(
        &mut self,
        title: &str,
    ) -> Result<NativeSessionsSnapshot, StoreError> {
        let trimmed = title.trim();
        let effective_title = if trimmed.is_empty() {
            "New chat"
        } else {
            trimmed
        };
        let req = CreateAgentSessionRequest {
            id: Some(uuid_v4()),
            title: effective_title.to_owned(),
            cwd: String::new(),
            environment: HarnessEnvironment::WindowsNative,
            model: UNCONFIGURED_MODEL_SENTINEL.to_owned(),
            token_budget: DEFAULT_TOKEN_BUDGET,
        };
        let now_ms = now_epoch_ms();
        let (created, _) = self.sessions.create_session(req, now_ms)?;
        upsert_native_meta(
            self.sessions.store().connection(),
            &created.id,
            true,
            "medium",
        )?;
        let snap = self.sessions.refresh()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Switch active session and persist navigation state.
    pub fn select_session(
        &mut self,
        session_id: &str,
    ) -> Result<NativeSessionsSnapshot, StoreError> {
        let (_, snap) = self
            .sessions
            .select_session(session_id, None, now_epoch_ms())?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Validate and save settings (`title`, `model`, `effort`) with strict CAS `expected_revision`.
    pub fn update_settings(
        &mut self,
        session_id: &str,
        expected_revision: i64,
        title: &str,
        model: &str,
        effort: &str,
    ) -> Result<NativeSessionsSnapshot, StoreError> {
        let validated = validate_session_settings_input(title, model, effort)?;
        let req = UpdateAgentSessionSettingsRequest {
            session_id: session_id.to_owned(),
            expected_revision,
            title: validated.title,
            model: validated.model,
        };
        let (updated, _) = self.sessions.update_settings(req, now_epoch_ms())?;
        upsert_native_meta(
            self.sessions.store().connection(),
            &updated.id,
            false,
            &validated.effort,
        )?;
        let snap = self.sessions.refresh()?;
        project_snapshot(self.sessions.store().connection(), snap)
    }

    /// Seed the canonical 125-row QA paging/guard fixture (`"Off-page active"` + `124` synthetic rows).
    ///
    /// Exact layout:
    /// - 1 active session `"Off-page active"` with `updated_at_ms = 1`, `revision = 1`, empty UI model `""`, effort `"medium"`.
    /// - 124 sessions `"paging-fixture-0000"`..`"paging-fixture-0123"` (`"Synthetic session 0000"`..`"Synthetic session 0123"`) at `updated_at_ms = 100`.
    pub fn seed_paging_fixture(&mut self) -> Result<NativeSessionsSnapshot, StoreError> {
        let snap = self.create_projectless_session("Off-page active")?;
        let active_summary = snap.active_session.as_ref().ok_or_else(|| {
            StoreError::new(
                "fixture_seed_failed",
                "Active session missing after create.",
                false,
            )
        })?;
        let mut active_raw = self
            .sessions
            .store()
            .get_agent_session(&active_summary.id)?
            .ok_or_else(|| {
                StoreError::new("fixture_seed_failed", "Active raw session missing.", false)
            })?;
        active_raw.updated_at_ms = 1;
        active_raw.created_at_ms = 1;
        let saved_active = self
            .sessions
            .store_mut()
            .upsert_agent_session(&active_raw)?;

        for index in 0..124usize {
            let id = format!("paging-fixture-{index:04}");
            let title = format!("Synthetic session {index:04}");
            let row = AgentSessionSummary {
                id: id.clone(),
                title,
                updated_at_ms: 100,
                created_at_ms: 100,
                ..saved_active.clone()
            };
            let _ = self.sessions.store_mut().upsert_agent_session(&row)?;
            upsert_native_meta(self.sessions.store().connection(), &id, true, "medium")?;
        }

        self.sessions.first_page()?;
        let final_snap = self.sessions.refresh()?;
        project_snapshot(self.sessions.store().connection(), final_snap)
    }
}

/// Command executed asynchronously on [`NativeSessionWorker`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeSessionCommand {
    Refresh,
    FirstPage,
    NextPage,
    PrevPage,
    CreateProjectless {
        title: String,
    },
    Select {
        session_id: String,
    },
    UpdateSettings {
        session_id: String,
        expected_revision: i64,
        title: String,
        model: String,
        effort: String,
    },
}

/// Completed operation descriptor delivered from [`NativeSessionWorker`].
#[derive(Debug, Clone)]
pub struct NativeSessionEvent {
    pub op_id: u64,
    pub is_startup_open: bool,
    pub result: Result<NativeSessionsSnapshot, StoreError>,
}

struct WorkerShared {
    stop: bool,
    busy: bool,
    pending_cmd: Option<(u64, NativeSessionCommand)>,
    completed: Option<NativeSessionEvent>,
}

/// Dedicated background SQLite worker with non-blocking startup open, `1`-command queue guard,
/// and Win32 `WM_APP` wake callback.
pub struct NativeSessionWorker {
    shared: Arc<(Mutex<WorkerShared>, Condvar)>,
    next_op_id: AtomicU64,
    handle: Option<JoinHandle<()>>,
}

impl NativeSessionWorker {
    /// Spawn a background worker that opens `db_path` asynchronously and fires `wake_cb` on every completion.
    pub fn spawn<F>(db_path: PathBuf, wake_cb: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let shared = Arc::new((
            Mutex::new(WorkerShared {
                stop: false,
                busy: true,
                pending_cmd: None,
                completed: None,
            }),
            Condvar::new(),
        ));
        let worker_shared = Arc::clone(&shared);
        let wake = Arc::new(wake_cb);

        let handle = thread::Builder::new()
            .name("omnia-native-session-worker".to_owned())
            .spawn(move || {
                let open_res = NativeSessionStore::open(&db_path).and_then(|mut store| {
                    let snap = store.refresh()?;
                    Ok((store, snap))
                });

                let (mut store_opt, persistent_err, initial_result) = match open_res {
                    Ok((store, snap)) => (Some(store), None, Ok(snap)),
                    Err(err) => (None, Some(err.clone()), Err(err)),
                };

                {
                    let (lock, cv) = &*worker_shared;
                    let mut guard = match lock.lock() {
                        Ok(g) => g,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    guard.busy = false;
                    guard.completed = Some(NativeSessionEvent {
                        op_id: 1,
                        is_startup_open: true,
                        result: initial_result,
                    });
                    cv.notify_all();
                }
                wake();

                loop {
                    let next_work = {
                        let (lock, cv) = &*worker_shared;
                        let mut guard = match lock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        while !guard.stop && guard.pending_cmd.is_none() {
                            guard = match cv.wait(guard) {
                                Ok(g) => g,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                        }
                        if guard.stop && guard.pending_cmd.is_none() {
                            break;
                        }
                        guard.pending_cmd.take()
                    };

                    let Some((op_id, cmd)) = next_work else {
                        continue;
                    };

                    let res = if let Some(ref mut store) = store_opt {
                        execute_command(store, cmd)
                    } else if let Some(ref err) = persistent_err {
                        Err(err.clone())
                    } else {
                        Err(StoreError::new(
                            "session_store_unavailable",
                            "Session database is not connected.",
                            false,
                        ))
                    };

                    {
                        let (lock, cv) = &*worker_shared;
                        let mut guard = match lock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        guard.busy = false;
                        guard.completed = Some(NativeSessionEvent {
                            op_id,
                            is_startup_open: false,
                            result: res,
                        });
                        cv.notify_all();
                    }
                    wake();
                }

                drop(store_opt);
            })
            .ok();

        Self {
            shared,
            next_op_id: AtomicU64::new(2),
            handle,
        }
    }

    /// Spawn a worker backed by a custom execution closure for unit testing bounded-queue / locking behavior.
    pub fn spawn_with_executor<E, F>(executor: E, wake_cb: F) -> Self
    where
        E: FnMut(NativeSessionCommand) -> Result<NativeSessionsSnapshot, StoreError>
            + Send
            + 'static,
        F: Fn() + Send + Sync + 'static,
    {
        let shared = Arc::new((
            Mutex::new(WorkerShared {
                stop: false,
                busy: false,
                pending_cmd: None,
                completed: None,
            }),
            Condvar::new(),
        ));
        let worker_shared = Arc::clone(&shared);
        let wake = Arc::new(wake_cb);

        let handle = thread::Builder::new()
            .name("omnia-native-session-test-worker".to_owned())
            .spawn(move || {
                let mut exec = executor;
                loop {
                    let next_work = {
                        let (lock, cv) = &*worker_shared;
                        let mut guard = match lock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        while !guard.stop && guard.pending_cmd.is_none() {
                            guard = match cv.wait(guard) {
                                Ok(g) => g,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                        }
                        if guard.stop && guard.pending_cmd.is_none() {
                            break;
                        }
                        guard.pending_cmd.take()
                    };

                    let Some((op_id, cmd)) = next_work else {
                        continue;
                    };

                    let res = exec(cmd);
                    {
                        let (lock, cv) = &*worker_shared;
                        let mut guard = match lock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        guard.busy = false;
                        guard.completed = Some(NativeSessionEvent {
                            op_id,
                            is_startup_open: false,
                            result: res,
                        });
                        cv.notify_all();
                    }
                    wake();
                }
            })
            .ok();

        Self {
            shared,
            next_op_id: AtomicU64::new(1),
            handle,
        }
    }

    /// Return `true` while startup open or an async SQLite command is in flight.
    #[must_use]
    pub fn is_busy(&self) -> bool {
        let (lock, _) = &*self.shared;
        let guard = match lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.busy
    }

    /// Submit a single command if idle; rejects concurrent callers with `session_worker_busy`.
    pub fn submit(&self, cmd: NativeSessionCommand) -> Result<u64, StoreError> {
        let (lock, cv) = &*self.shared;
        let mut guard = match lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.stop {
            return Err(StoreError::new(
                "session_worker_stopped",
                "Session worker is shutting down.",
                false,
            ));
        }
        if guard.busy || guard.pending_cmd.is_some() {
            return Err(StoreError::new(
                "session_worker_busy",
                "Storage operation pending...",
                true,
            ));
        }
        let op_id = self.next_op_id.fetch_add(1, Ordering::Relaxed);
        guard.busy = true;
        guard.pending_cmd = Some((op_id, cmd));
        cv.notify_all();
        Ok(op_id)
    }

    /// Take the latest completed worker event if one is ready.
    #[must_use]
    pub fn take_completed(&self) -> Option<NativeSessionEvent> {
        let (lock, _) = &*self.shared;
        let mut guard = match lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.completed.take()
    }

    /// Signal stop and join the worker thread so SQLite ownership locks drop cleanly before exit.
    pub fn stop_and_wait(&mut self) {
        {
            let (lock, cv) = &*self.shared;
            let mut guard = match lock.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.stop = true;
            cv.notify_all();
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for NativeSessionWorker {
    fn drop(&mut self) {
        self.stop_and_wait();
    }
}

fn execute_command(
    store: &mut NativeSessionStore,
    cmd: NativeSessionCommand,
) -> Result<NativeSessionsSnapshot, StoreError> {
    match cmd {
        NativeSessionCommand::Refresh => store.refresh(),
        NativeSessionCommand::FirstPage => store.first_page(),
        NativeSessionCommand::NextPage => store.next_page(),
        NativeSessionCommand::PrevPage => store.prev_page(),
        NativeSessionCommand::CreateProjectless { title } => {
            store.create_projectless_session(&title)
        }
        NativeSessionCommand::Select { session_id } => store.select_session(&session_id),
        NativeSessionCommand::UpdateSettings {
            session_id,
            expected_revision,
            title,
            model,
            effort,
        } => store.update_settings(&session_id, expected_revision, &title, &model, &effort),
    }
}
