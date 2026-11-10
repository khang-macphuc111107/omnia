//! Native UI service over the canonical session database. No provider or tool
//! is dispatched by metadata operations. CAS conflicts are returned to the UI.
use omnia_harness::permission::PermissionMode;
use omnia_session_store::{
    error::{NativeError, NativeResult},
    harness_store::{AgentSessionSummary, HarnessStore, SessionScope},
    session_navigation::{
        AgentSessionNavigationLoad, AgentSessionNavigationSave, AgentSessionPageCursor,
        AgentSessionPageRequest, SaveAgentSessionNavigationRequest,
    },
};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct Sessions {
    store: std::sync::Arc<HarnessStore>,
}

#[derive(Debug)]
pub struct SessionSnapshot {
    pub rows: Vec<AgentSessionSummary>,
    pub active: Option<AgentSessionSummary>,
    pub navigation_revision: i64,
    pub cursor: Option<AgentSessionPageCursor>,
    pub next_cursor: Option<AgentSessionPageCursor>,
}

pub enum SessionCommand {
    Refresh,
    Page {
        cursor: Option<AgentSessionPageCursor>,
    },
    Create {
        expected_revision: i64,
    },
    Select {
        id: String,
        expected_revision: i64,
    },
    Update {
        id: String,
        expected_revision: u64,
        title: String,
        model: String,
        effort: String,
    },
}

/// Exactly one lazy metadata worker and one pending command. SQLite lock waits
/// never run on the Windows UI thread. Drop stops admission and queued work;
/// an already executing SQLite operation may finish before the worker exits.
pub struct SessionWorker {
    commands: std::sync::mpsc::SyncSender<SessionCommand>,
    responses: std::sync::mpsc::Receiver<NativeResult<SessionSnapshot>>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl SessionWorker {
    pub fn start(
        database: std::path::PathBuf,
        notify: impl Fn() + Send + 'static,
    ) -> NativeResult<Self> {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        };
        let (commands, receiver) = mpsc::sync_channel(1);
        let (sender, responses) = mpsc::sync_channel(2);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let thread = std::thread::Builder::new()
            .name("omnia-session-store".into())
            .spawn(move || {
                let service = match Sessions::open(&database) {
                    Ok(service) => service,
                    Err(error) => {
                        let _ = sender.try_send(Err(error));
                        notify();
                        return;
                    }
                };
                let _ = sender.try_send(service.snapshot());
                if !worker_cancelled.load(Ordering::Acquire) {
                    notify();
                }
                while let Ok(command) = receiver.recv() {
                    if worker_cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    let result = service.execute(command);
                    if worker_cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    if sender.try_send(result).is_err() {
                        break;
                    }
                    notify();
                }
            })
            .map_err(|_| {
                NativeError::new(
                    "session_worker_unavailable",
                    "The session worker could not start",
                )
            })?;
        Ok(Self {
            commands,
            responses,
            cancelled,
            thread: Some(thread),
        })
    }

    pub fn submit(&self, command: SessionCommand) -> NativeResult<()> {
        self.commands.try_send(command).map_err(|_| {
            NativeError::new(
                "session_worker_busy",
                "Session worker is busy or stopped; no automatic retry",
            )
        })
    }

    pub fn poll(&self) -> Option<NativeResult<SessionSnapshot>> {
        use std::sync::mpsc::TryRecvError;
        match self.responses.try_recv() {
            Ok(response) => Some(response),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err(NativeError::new(
                "session_worker_stopped",
                "Session worker stopped; reopen storage explicitly",
            ))),
        }
    }

    #[cfg(test)]
    fn stop_and_wait(mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        let _ = self.commands.try_send(SessionCommand::Refresh);
        self.thread.take().unwrap().join().unwrap();
    }
}

impl Drop for SessionWorker {
    fn drop(&mut self) {
        self.cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        let _ = self.commands.try_send(SessionCommand::Refresh);
        // Dropping a JoinHandle detaches; never block the UI waiting for SQLite.
        self.thread.take();
    }
}

pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

fn now_ms() -> NativeResult<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            NativeError::new(
                "invalid_clock",
                "System clock is before the supported epoch",
            )
        })?
        .as_millis();
    i64::try_from(millis)
        .map_err(|_| NativeError::new("invalid_clock", "System clock exceeds the supported range"))
}

fn validate_text(value: &str, name: &'static str, max: usize) -> NativeResult<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            name,
            "must be nonempty, bounded and control-free",
        ));
    }
    Ok(())
}

impl Sessions {
    pub fn snapshot(&self) -> NativeResult<SessionSnapshot> {
        self.page(None)
    }

    pub fn page(&self, cursor: Option<AgentSessionPageCursor>) -> NativeResult<SessionSnapshot> {
        let page = self.store.session_page(AgentSessionPageRequest {
            limit: 50,
            cursor: cursor.clone(),
        })?;
        Ok(SessionSnapshot {
            rows: page.rows,
            active: page.active,
            navigation_revision: page.navigation.snapshot.revision,
            cursor,
            next_cursor: page.next_cursor,
        })
    }

    fn execute(&self, command: SessionCommand) -> NativeResult<SessionSnapshot> {
        if let SessionCommand::Page { cursor } = command {
            return self.page(cursor);
        }
        let selection = match command {
            SessionCommand::Page { .. } => unreachable!(),
            SessionCommand::Refresh => None,
            SessionCommand::Create { expected_revision } => {
                let summary = self.create("New chat")?;
                Some(self.select(&summary.id, expected_revision)?)
            }
            SessionCommand::Select {
                id,
                expected_revision,
            } => Some(self.select(&id, expected_revision)?),
            SessionCommand::Update {
                id,
                expected_revision,
                title,
                model,
                effort,
            } => {
                self.update_settings(&id, expected_revision, &title, &model, &effort)?;
                None
            }
        };
        if matches!(selection, Some(AgentSessionNavigationSave::Conflict { .. })) {
            return Err(NativeError::new("navigation_conflict",
                "Navigation changed. Refresh and select again; a newly created session remains in the session list."));
        }
        self.snapshot()
    }
    pub fn open(database: &Path) -> NativeResult<Self> {
        Ok(Self::from_shared(std::sync::Arc::new(HarnessStore::open(
            database,
        )?)))
    }

    /// Share the already-owned database with execution services. This never
    /// reopens SQLite or runs startup recovery for a second observer.
    pub fn from_shared(store: std::sync::Arc<HarnessStore>) -> Self {
        Self { store }
    }

    pub fn list(&self) -> NativeResult<Vec<AgentSessionSummary>> {
        self.store.list()
    }

    pub fn navigation(&self) -> NativeResult<AgentSessionNavigationLoad> {
        self.store.load_session_navigation()
    }

    pub fn summary(&self, id: &str) -> NativeResult<AgentSessionSummary> {
        self.store.summary(id)
    }

    /// A durable projectless session. The provider profile is unconfigured;
    /// creating this record grants no filesystem/process/network permission.
    pub fn create(&self, title: &str) -> NativeResult<AgentSessionSummary> {
        validate_text(title, "title", 256)?;
        let timestamp = now_ms()?;
        let summary = AgentSessionSummary {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_owned(),
            scope: SessionScope::Projectless,
            cwd: String::new(),
            profile_id: String::new(),
            model: String::new(),
            permission_mode: PermissionMode::AskAll,
            rules: Vec::new(),
            reasoning_effort: None,
            fallback_models: Vec::new(),
            token_budget: None,
            tokens_used: 0,
            system_prompt: None,
            parent_id: None,
            settings_revision: 1,
            message_count: 0,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        };
        self.store.save_summary(&summary)?;
        self.store.summary(&summary.id)
    }

    /// Exactly one navigation CAS. No automatic replay on conflict. The
    /// previously created session remains discoverable even if selection fails.
    pub fn select(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> NativeResult<AgentSessionNavigationSave> {
        let current = self.navigation()?;
        let mut ids = current.snapshot.open_ids;
        if !ids.iter().any(|item| item == id) {
            ids.push(id.to_owned());
        }
        self.store
            .save_session_navigation(SaveAgentSessionNavigationRequest {
                expected_revision,
                open_ids: ids,
                active_id: Some(id.to_owned()),
            })
    }

    pub fn update_settings(
        &self,
        id: &str,
        expected_revision: u64,
        title: &str,
        model: &str,
        effort: &str,
    ) -> NativeResult<AgentSessionSummary> {
        validate_text(title, "title", 256)?;
        validate_text(model, "model", 256)?;
        if !EFFORTS.contains(&effort) {
            return Err(NativeError::invalid(
                "effort",
                "must be a supported effort name; ultra requires a separate workflow policy",
            ));
        }
        let timestamp = now_ms()?;
        self.store
            .update_summary_cas(id, Some(expected_revision), |session| {
                session.title = title.to_owned();
                session.model = model.to_owned();
                session.reasoning_effort = Some(effort.to_owned());
                session.updated_at_ms = timestamp;
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_returns_durable_state_without_ui_thread_database_calls() {
        let directory = tempfile::tempdir().unwrap();
        let worker = SessionWorker::start(directory.path().join("harness.sqlite3"), || {}).unwrap();
        let initial = worker
            .responses
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(initial.rows.is_empty());
        worker
            .submit(SessionCommand::Create {
                expected_revision: 0,
            })
            .unwrap();
        let created = worker
            .responses
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let active = created.active.unwrap();
        assert_eq!(created.navigation_revision, 1);
        assert_eq!(created.rows.len(), 1);
        assert_eq!(active.scope, SessionScope::Projectless);
        worker
            .submit(SessionCommand::Update {
                id: active.id.clone(),
                expected_revision: 1,
                title: "Worker saved".into(),
                model: "native/test".into(),
                effort: "high".into(),
            })
            .unwrap();
        let saved = worker
            .responses
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(saved.active.unwrap().settings_revision, 2);
        worker
            .submit(SessionCommand::Update {
                id: active.id,
                expected_revision: 1,
                title: "Stale".into(),
                model: "native/test".into(),
                effort: "low".into(),
            })
            .unwrap();
        assert!(worker
            .responses
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .is_err());
        // Worker exit is asynchronous; directory deletion on Windows must wait
        // until the bounded worker drops its SQLite handle.
        worker.stop_and_wait();
        directory.close().unwrap();
    }

    #[test]
    fn command_queue_is_bounded_and_drop_cancels_pending_work() {
        let (commands, _receiver) = std::sync::mpsc::sync_channel(1);
        let (_sender, responses) = std::sync::mpsc::sync_channel(2);
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker = SessionWorker {
            commands,
            responses,
            cancelled: cancelled.clone(),
            thread: None,
        };
        worker.submit(SessionCommand::Refresh).unwrap();
        assert_eq!(
            worker.submit(SessionCommand::Refresh).unwrap_err().code,
            "session_worker_busy"
        );
        drop(worker);
        assert!(cancelled.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn native_page_is_bounded_and_preserves_off_page_active_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("paging.sqlite3");
        let service = Sessions::open(&database).unwrap();
        let mut oldest = service.create("Oldest active").unwrap();
        oldest.updated_at_ms = 1;
        service.store.save_summary(&oldest).unwrap();
        service.select(&oldest.id, 0).unwrap();
        for index in 0..124 {
            let mut summary = oldest.clone();
            summary.id = format!("page-{index:04}");
            summary.title = format!("Page fixture {index}");
            summary.updated_at_ms = 100;
            service.store.save_summary(&summary).unwrap();
        }
        let first = service.snapshot().unwrap();
        assert_eq!(first.rows.len(), 50);
        assert_eq!(first.active.as_ref().unwrap().id, oldest.id);
        assert!(!first.rows.iter().any(|row| row.id == oldest.id));
        let first_cursor = first.next_cursor.clone().unwrap();
        let second = service
            .execute(SessionCommand::Page {
                cursor: Some(first_cursor.clone()),
            })
            .unwrap();
        assert_eq!(second.rows.len(), 50);
        assert_eq!(second.cursor, Some(first_cursor));
        let third = service.page(second.next_cursor).unwrap();
        assert_eq!(third.rows.len(), 25);
        assert!(third.next_cursor.is_none());
        let ids: std::collections::HashSet<_> = first
            .rows
            .into_iter()
            .chain(second.rows)
            .chain(third.rows)
            .map(|row| row.id)
            .collect();
        assert_eq!(ids.len(), 125);
        drop(service);
        let reopened = Sessions::open(&database).unwrap().snapshot().unwrap();
        assert_eq!(reopened.rows.len(), 50);
        assert_eq!(reopened.active.unwrap().id, oldest.id);
    }

    #[test]
    fn native_sessions_reopen_with_exact_shared_schema_and_navigation() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("harness.sqlite3");
        let id;
        {
            let service = Sessions::open(&database).unwrap();
            let session = service.create("Nghiên cứu ∑").unwrap();
            id = session.id;
            assert_eq!(session.scope, SessionScope::Projectless);
            assert_eq!(session.permission_mode, PermissionMode::AskAll);
            assert!(session.profile_id.is_empty());
            assert!(matches!(
                service.select(&id, 0).unwrap(),
                AgentSessionNavigationSave::Saved { .. }
            ));
            service
                .update_settings(&id, 1, "Research", "local/model", "high")
                .unwrap();
        }
        let service = Sessions::open(&database).unwrap();
        assert_eq!(service.summary(&id).unwrap().settings_revision, 2);
        assert_eq!(service.summary(&id).unwrap().model, "local/model");
        assert_eq!(
            service.navigation().unwrap().snapshot.active_id.as_deref(),
            Some(id.as_str())
        );
        // Open through the canonical authority, not a second native schema.
        drop(service);
        let canonical = HarnessStore::open(&database).unwrap();
        assert_eq!(
            canonical.summary(&id).unwrap().reasoning_effort.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn native_metadata_view_shares_admission_owner_without_recovery() {
        use omnia_session_store::run_coordinator::RunCoordinator;
        use std::sync::Arc;

        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("harness.sqlite3");
        let runtime = RunCoordinator::<()>::from_store(HarnessStore::open(&database).unwrap());
        let service = Sessions::from_shared(Arc::clone(runtime.store()));
        assert!(Arc::ptr_eq(&service.store, runtime.store()));
        let session = service.create("Shared owner").unwrap();
        let admitted = runtime.admit(&session.id, Arc::new(())).unwrap();
        service
            .update_settings(&session.id, 1, "Updated metadata", "local/model", "high")
            .unwrap();
        assert_eq!(
            runtime
                .store()
                .summary(&session.id)
                .unwrap()
                .settings_revision,
            2
        );
        assert_eq!(
            Sessions::open(&database).err().unwrap().code,
            "harness_store_busy"
        );
        assert!(runtime.runs().remove_current(&admitted.ticket).unwrap());
        drop(runtime);
        // The actual native metadata view retains the same store ownership.
        assert_eq!(
            service.summary(&session.id).unwrap().title,
            "Updated metadata"
        );
        assert_eq!(
            Sessions::open(&database).err().unwrap().code,
            "harness_store_busy"
        );
        drop(service);
        let reopened = Sessions::open(&database).unwrap();
        assert_eq!(reopened.summary(&session.id).unwrap().model, "local/model");
    }

    #[test]
    fn stale_and_invalid_settings_do_not_overwrite_committed_values() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("harness.sqlite3");
        let first = Sessions::open(&database).unwrap();
        // Separate native service views share the same live database owner.
        let second = Sessions::from_shared(std::sync::Arc::clone(&first.store));
        let session = first.create("First").unwrap();
        first
            .update_settings(&session.id, 1, "Committed", "model-a", "max")
            .unwrap();
        assert!(second
            .update_settings(&session.id, 1, "Stale", "model-b", "low")
            .is_err());
        for (title, model, effort, revision) in [
            ("", "model", "max", 2),
            ("ok", "", "max", 2),
            ("ok", "model\n", "max", 2),
            ("ok", "model", "ultra", 2),
            ("ok", "model", "max", 0),
        ] {
            assert!(second
                .update_settings(&session.id, revision, title, model, effort)
                .is_err());
        }
        assert_eq!(first.summary(&session.id).unwrap().title, "Committed");
        assert_eq!(first.summary(&session.id).unwrap().settings_revision, 2);
        first.select(&session.id, 0).unwrap();
        assert!(matches!(
            second.select(&session.id, 0).unwrap(),
            AgentSessionNavigationSave::Conflict { .. }
        ));
    }
}
