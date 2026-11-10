//! Installed VS Code web runtime, owned by the native application lifecycle.
//!
//! Renderer requests select native-owned folder ids; they never supply a
//! command, executable, port, or filesystem path to a launch operation.

use std::{
    fs,
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::{State, Webview};
use tauri_plugin_dialog::DialogExt;

use crate::error::{NativeError, NativeResult};

const EDITOR_ORIGIN: &str = "http://127.0.0.1:1430";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_FOLDERS: usize = 32;
const MAX_WORKSPACE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFolder {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Default, Serialize, Deserialize)]
struct WorkspaceDocument {
    folders: Vec<EditorFolder>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWorkspace {
    pub folders: Vec<EditorFolder>,
    pub workspace_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorServerStatus {
    pub state: &'static str,
    pub url: String,
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone)]
pub struct EditorServerManager {
    inner: Arc<Mutex<ManagerState>>,
    workspace_file: PathBuf,
    registry_file: PathBuf,
    connection_token: Arc<String>,
}

#[derive(Default)]
struct ManagerState {
    generation: u64,
    child: Option<ManagedChild>,
    starting_at: Option<Instant>,
    failure: Option<String>,
    stopped: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupReservation {
    Reserved(u64),
    Ready,
    Starting,
    Stopped,
    AddressConflict,
}

impl ManagerState {
    fn advance_generation(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("editor lifecycle generation exhausted");
    }
}

struct ManagedChild {
    #[cfg(windows)]
    process: WindowsProcess,
    #[cfg(windows)]
    _job: WindowsJob,
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        // On Windows closing the job below terminates every descendant too,
        // including a server spawned by the official CLI fallback.
        #[cfg(windows)]
        self.process.terminate();
    }
}

impl ManagedChild {
    fn exited(&self) -> bool {
        #[cfg(windows)]
        {
            self.process.exited()
        }
        #[cfg(not(windows))]
        {
            true
        }
    }
}

impl EditorServerManager {
    pub fn new(app_data: &Path) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ManagerState::default())),
            workspace_file: app_data.join("editor").join("omnia.code-workspace"),
            registry_file: app_data.join("editor").join("folders.json"),
            connection_token: Arc::new(uuid::Uuid::new_v4().simple().to_string()),
        }
    }

    fn lock(&self) -> NativeResult<std::sync::MutexGuard<'_, ManagerState>> {
        self.inner
            .lock()
            .map_err(|_| NativeError::new("editor_state_failed", "The editor state is unavailable"))
    }

    fn editor_url(&self) -> String {
        let mut url = url::Url::parse(EDITOR_ORIGIN).expect("fixed editor origin");
        url.query_pairs_mut()
            .append_pair("tkn", &self.connection_token);
        url.into()
    }

    fn status_value(&self, state: &'static str, message: Option<String>) -> EditorServerStatus {
        EditorServerStatus {
            state,
            // Renderer status describes availability; only the native probe and
            // child document receive the ephemeral connection credential.
            url: EDITOR_ORIGIN.to_owned(),
            workspace_path: self.workspace_file.to_string_lossy().into_owned(),
            message,
        }
    }

    pub fn workspace(&self) -> NativeResult<EditorWorkspace> {
        let _guard = self.lock()?;
        self.workspace_unlocked()
    }

    /// Construct the child document only from the manager's selected folders.
    /// The second value is private lifecycle state, never a renderer credential.
    pub(crate) fn surface_document(
        &self,
        folder_id: Option<&str>,
    ) -> NativeResult<(url::Url, String)> {
        // Read the selected folders and the owned process generation under the
        // same manager guard. A replacement editor process must receive a new
        // document identity even when it serves the same workspace paths;
        // remounts against the same published child keep the identity stable.
        let state = self.lock()?;
        let workspace = self.workspace_unlocked()?;
        let published_generation = state.child.as_ref().map(|_| state.generation).unwrap_or(0);
        let mut url = url::Url::parse(&self.editor_url()).expect("fixed editor origin");
        let document_key = match folder_id {
            Some(folder_id) => {
                if !valid_folder_id(folder_id) {
                    return Err(NativeError::invalid(
                        "folderId",
                        "must identify a selected editor folder",
                    ));
                }
                let folder = workspace
                    .folders
                    .iter()
                    .find(|folder| folder.id == folder_id)
                    .ok_or_else(|| {
                        NativeError::new(
                            "editor_folder_missing",
                            "The selected editor folder no longer exists",
                        )
                    })?;
                validate_registered_folder(folder)?;
                let path = editor_uri_path(&folder.path);
                url.query_pairs_mut().append_pair("folder", &path);
                format!("folder:{}:{}:{}", published_generation, folder.id, path)
            }
            None => {
                url.query_pairs_mut()
                    .append_pair("workspace", &editor_uri_path(&workspace.workspace_path));
                format!(
                    "workspace:{}:{}",
                    published_generation,
                    serde_json::to_string(&workspace.folders).map_err(|_| NativeError::new(
                        "editor_workspace_failed",
                        "The editor workspace could not be encoded"
                    ))?
                )
            }
        };
        Ok((url, document_key))
    }

    fn workspace_unlocked(&self) -> NativeResult<EditorWorkspace> {
        let document = match read_bounded_workspace_file(&self.registry_file)? {
            Some(bytes) => {
                let document =
                    serde_json::from_slice::<WorkspaceDocument>(&bytes).map_err(|_| {
                        invalid_workspace("The native editor folder registry is invalid")
                    })?;
                validate_document(&document)?;
                document
            }
            None => {
                // Migrate only records written by Omnia's previous native
                // picker. A vendor-authored path without an opaque native id
                // must never become a new native-picked authority record.
                let document = match read_bounded_workspace_file(&self.workspace_file)? {
                    Some(bytes) => {
                        let text = std::str::from_utf8(&bytes).map_err(|_| {
                            invalid_workspace("The editor workspace is not UTF-8 text")
                        })?;
                        let json = sanitized_workspace_json(text)?;
                        let document = serde_json::from_slice::<WorkspaceDocument>(&json).map_err(|_| {
                            invalid_workspace("Native editor folder records are missing. Select the editor folders again")
                        })?;
                        validate_document(&document)?;
                        document
                    }
                    None => WorkspaceDocument::default(),
                };
                let bytes = serde_json::to_vec_pretty(&document).map_err(|_| {
                    invalid_workspace("The native editor folder registry could not be encoded")
                })?;
                atomic_workspace_write(&self.registry_file, &bytes)?;
                document
            }
        };
        self.save_vendor_projection(&document)?;
        Ok(EditorWorkspace {
            folders: document.folders,
            workspace_path: self.workspace_file.to_string_lossy().into_owned(),
        })
    }

    fn save_workspace(&self, document: &WorkspaceDocument) -> NativeResult<()> {
        validate_document(document)?;
        // Prepare first so malformed vendor JSONC cannot silently destroy
        // settings or mutate native authority during a failed picker action.
        let projection = self.vendor_projection(document)?;
        let bytes = serde_json::to_vec_pretty(document).map_err(|_| {
            invalid_workspace("The native editor folder registry could not be encoded")
        })?;
        // Registry is authoritative. If projection persistence subsequently
        // fails, retry rebuilds it from these durable native-picked records.
        atomic_workspace_write(&self.registry_file, &bytes)?;
        if let Some(projection) = projection {
            atomic_workspace_write(&self.workspace_file, projection.as_bytes())?;
        }
        Ok(())
    }

    fn vendor_projection(&self, document: &WorkspaceDocument) -> NativeResult<Option<String>> {
        let source = read_bounded_workspace_file(&self.workspace_file)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| invalid_workspace("The editor workspace is not UTF-8 text"))?
            .unwrap_or_else(|| "{\n}\n".to_owned());
        project_native_folders(&source, &document.folders)
    }

    fn save_vendor_projection(&self, document: &WorkspaceDocument) -> NativeResult<()> {
        if let Some(projected) = self.vendor_projection(document)? {
            atomic_workspace_write(&self.workspace_file, projected.as_bytes())?;
        }
        Ok(())
    }

    fn recover_picked_vendor_workspace(
        &self,
        canonical: &Path,
    ) -> NativeResult<Option<EditorWorkspace>> {
        // Recovery is reachable only after an explicit, validated native
        // picker result. Existing native metadata, including corrupt data,
        // must continue through the ordinary fail-closed reader instead.
        if read_bounded_workspace_file(&self.registry_file)?.is_some() {
            return Ok(None);
        }
        let Some(bytes) = read_bounded_workspace_file(&self.workspace_file)? else {
            return Ok(None);
        };
        let source = std::str::from_utf8(&bytes)
            .map_err(|_| invalid_workspace("The editor workspace is not UTF-8 text"))?;
        let json = sanitized_workspace_json(source)?;
        let vendor: serde_json::Value =
            serde_json::from_slice(&json).expect("validated vendor workspace");
        let folders = match vendor.get("folders") {
            None => &[][..],
            Some(serde_json::Value::Array(folders)) => folders.as_slice(),
            Some(_) => return Err(invalid_workspace(
                "The workspace folders property must be an array. Restore a valid workspace backup before selecting folders again",
            )),
        };
        let native_records = folders
            .iter()
            .filter(|folder| folder.get("id").is_some())
            .count();
        if native_records != 0 {
            if native_records != folders.len() {
                return Err(invalid_workspace(
                    "The workspace mixes native folder records and vendor folder references, but its native registry is missing. Restore the matching folders.json backup before selecting folders again",
                ));
            }
            // Preserve migration of a complete legacy native document. The
            // ordinary reader validates every opaque id and canonical record.
            return Ok(None);
        }
        if !folders.iter().all(|folder| {
            folder.as_object().is_some_and(|record| {
                record
                    .keys()
                    .all(|key| matches!(key.as_str(), "name" | "path" | "uri"))
                    && match (record.get("path"), record.get("uri")) {
                        (Some(serde_json::Value::String(path)), None) => !path.is_empty(),
                        (None, Some(serde_json::Value::String(uri))) => !uri.is_empty(),
                        _ => false,
                    }
                    && record
                        .get("name")
                        .map_or(true, serde_json::Value::is_string)
            })
        }) {
            return Err(invalid_workspace(
                "The workspace contains unsupported folder references. Restore a valid workspace backup before selecting folders again",
            ));
        }
        // The old paths remain untrusted even when they happen to match this
        // selection. Only this fresh picker result receives native authority.
        let document = WorkspaceDocument {
            folders: vec![picked_folder_record(canonical)],
        };
        validate_document(&document)?;
        let projection = project_native_folders(source, &document.folders)?;
        let registry = serde_json::to_vec_pretty(&document).map_err(|_| {
            invalid_workspace("The native editor folder registry could not be encoded")
        })?;
        let backup = self
            .workspace_file
            .parent()
            .expect("native editor directory")
            .join("workspace-backups")
            .join(format!(
                "before-native-picker-{}.code-workspace",
                uuid::Uuid::new_v4().simple()
            ));
        // Keep the original folder references and all original formatting in
        // an app-owned copy before either authority or projection is changed.
        atomic_workspace_write(&backup, &bytes)?;
        atomic_workspace_write(&self.registry_file, &registry)?;
        if let Some(projection) = projection {
            atomic_workspace_write(&self.workspace_file, projection.as_bytes())?;
        }
        Ok(Some(EditorWorkspace {
            folders: document.folders,
            workspace_path: self.workspace_file.to_string_lossy().into_owned(),
        }))
    }

    fn apply_picker_selection(&self, selected: Option<&Path>) -> NativeResult<EditorWorkspace> {
        match selected {
            Some(path) => self.add_picked_folder(path),
            None => self.workspace(),
        }
    }

    fn add_picked_folder(&self, path: &Path) -> NativeResult<EditorWorkspace> {
        let canonical = validate_folder(path)?;
        let _guard = self.lock()?;
        if let Some(recovered) = self.recover_picked_vendor_workspace(&canonical)? {
            return Ok(recovered);
        }
        let current = self.workspace_unlocked()?;
        let mut document = WorkspaceDocument {
            folders: current.folders,
        };
        if !document
            .folders
            .iter()
            .any(|folder| Path::new(&folder.path) == canonical)
        {
            if document.folders.len() >= MAX_FOLDERS {
                return Err(NativeError::invalid(
                    "folder",
                    "the editor supports at most 32 selected folders",
                ));
            }
            document.folders.push(picked_folder_record(&canonical));
            self.save_workspace(&document)?;
        }
        Ok(EditorWorkspace {
            folders: document.folders,
            workspace_path: current.workspace_path,
        })
    }

    fn remove_folder(&self, folder_id: &str) -> NativeResult<EditorWorkspace> {
        if !valid_folder_id(folder_id) {
            return Err(NativeError::invalid(
                "folderId",
                "must identify a previously selected editor folder",
            ));
        }
        let _guard = self.lock()?;
        let current = self.workspace_unlocked()?;
        let mut document = WorkspaceDocument {
            folders: current.folders,
        };
        if !document.folders.iter().any(|folder| folder.id == folder_id) {
            return Err(NativeError::new(
                "editor_folder_missing",
                "The selected editor folder no longer exists",
            ));
        }
        document.folders.retain(|folder| folder.id != folder_id);
        self.save_workspace(&document)?;
        Ok(EditorWorkspace {
            folders: document.folders,
            workspace_path: current.workspace_path,
        })
    }

    pub async fn status(&self) -> NativeResult<EditorServerStatus> {
        self.status_with_probe(|url| async move { probe_editor(&url).await })
            .await
    }

    async fn status_with_probe<P, F>(&self, probe: P) -> NativeResult<EditorServerStatus>
    where
        P: FnOnce(String) -> F,
        F: std::future::Future<Output = (&'static str, Option<String>)>,
    {
        let (generation, owns_process) = {
            let mut state = self.lock()?;
            if state.stopped {
                return Ok(self.status_value(
                    "unavailable",
                    Some("The editor has stopped with this application window.".into()),
                ));
            }
            if state.child.as_ref().is_some_and(ManagedChild::exited) {
                state.advance_generation();
                state.child.take();
                state.starting_at = None;
                state.failure =
                    Some("The local editor process stopped. Retry the connection.".into());
            }
            (state.generation, state.child.is_some())
        };
        // Do not send a prospective connection credential to an unrelated
        // service which already occupies the fixed loopback address.
        let probe_url = if owns_process {
            self.editor_url()
        } else {
            EDITOR_ORIGIN.to_owned()
        };
        let observation = probe(probe_url).await;
        let mut state = self.lock()?;
        if state.stopped {
            return Ok(self.status_value(
                "unavailable",
                Some("The editor has stopped with this application window.".into()),
            ));
        }
        if state.generation != generation || state.child.is_some() != owns_process {
            // The HTTP response belongs to a retired startup/process group.
            // Report current lifecycle state without clearing its deadline or
            // failure, and let the current generation perform its own probe.
            return Ok(self.current_unprobed_status(&state));
        }
        if state.child.as_ref().is_some_and(ManagedChild::exited) {
            state.advance_generation();
            state.child.take();
            state.starting_at = None;
            state.failure = Some("The local editor process stopped. Retry the connection.".into());
            return Ok(self.current_unprobed_status(&state));
        }
        if observation.0 == "ready" {
            if !owns_process {
                return Ok(self.status_value("error", Some("Another editor already owns port 1430. Close that editor service before starting Omnia's editor.".into())));
            }
            state.starting_at = None;
            state.failure = None;
            return Ok(self.status_value("ready", None));
        }
        if let Some(started) = state.starting_at {
            if started.elapsed() < STARTUP_TIMEOUT {
                return Ok(self.status_value("starting", Some("Starting the local editor…".into())));
            }
            state.advance_generation();
            state.child.take();
            state.starting_at = None;
            state.failure = Some(
                "The local editor did not become ready within 90 seconds. Retry the connection."
                    .into(),
            );
        }
        if owns_process && state.child.is_some() && state.starting_at.is_none() {
            state.failure = Some(
                "The owned editor stopped responding. Retry to restart its process group.".into(),
            );
        }
        if let Some(message) = state.failure.as_ref() {
            return Ok(self.status_value("error", Some(message.clone())));
        }
        Ok(self.status_value(observation.0, observation.1))
    }

    fn current_unprobed_status(&self, state: &ManagerState) -> EditorServerStatus {
        if state.stopped {
            self.status_value(
                "unavailable",
                Some("The editor has stopped with this application window.".into()),
            )
        } else if state.starting_at.is_some() {
            self.status_value("starting", Some("Starting the local editor…".into()))
        } else if let Some(message) = &state.failure {
            self.status_value("error", Some(message.clone()))
        } else if state.child.is_some() {
            self.status_value(
                "starting",
                Some("Checking the current local editor connection…".into()),
            )
        } else {
            self.status_value(
                "unavailable",
                Some("The local editor is not running.".into()),
            )
        }
    }

    pub async fn start(&self) -> NativeResult<EditorServerStatus> {
        let current = self.status().await?;
        if matches!(current.state, "ready" | "starting") {
            return Ok(current);
        }
        validate_startup_folders(&self.workspace()?.folders)?;
        let address =
            editor_socket_address(&url::Url::parse(EDITOR_ORIGIN).expect("fixed editor origin"))
                .expect("fixed editor loopback address");
        let generation = match self.reserve_startup(assess_listener(address))? {
            StartupReservation::Reserved(generation) => generation,
            StartupReservation::Ready => return Ok(self.status_value("ready", None)),
            StartupReservation::Starting => return Ok(self.status_value("starting", None)),
            StartupReservation::Stopped => return Ok(current),
            StartupReservation::AddressConflict => {
                // A past owned-process failure is not authority over a new
                // unrelated listener or an address reserved by the system.
                return Ok(self.status_value("error", Some("Port 1430 is occupied or unavailable. Close the existing editor service or free the port before retrying.".into())));
            }
        };
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let launching = manager.clone();
            let launched = tauri::async_runtime::spawn_blocking(move || launching.launch()).await;
            let result = match launched {
                Ok(result) => result,
                Err(_) => Err("The local editor launcher could not be completed.".into()),
            };
            match result {
                Ok(child) => {
                    if !manager
                        .publish_launched_child(generation, child)
                        .unwrap_or(false)
                    {
                        return;
                    }
                    loop {
                        match manager.status().await {
                            Ok(status) if status.state == "starting" => {
                                tokio::time::sleep(Duration::from_millis(400)).await
                            }
                            _ => break,
                        }
                    }
                }
                Err(message) => {
                    let _ = manager.record_launch_failure(generation, message);
                }
            }
        });
        Ok(self.status_value("starting", Some("Starting the local editor…".into())))
    }

    fn launch(&self) -> Result<ManagedChild, String> {
        #[cfg(not(windows))]
        {
            Err("The embedded editor launcher is currently available on Windows only.".into())
        }
        #[cfg(windows)]
        {
            let home = std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .ok_or("The Windows user directory is unavailable.")?;
            let (executable, prefix) = discover_runtime(&home)
                .ok_or("Install VS Code or VS Code Insiders, then retry the editor connection.")?;
            let job = WindowsJob::create().map_err(|_| {
                "The application could not create an owned editor process group.".to_string()
            })?;
            let mut arguments = prefix;
            arguments.extend(
                [
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "1430",
                    "--accept-server-license-terms",
                    "--connection-token",
                    &self.connection_token,
                ]
                .into_iter()
                .map(str::to_owned),
            );
            let process = WindowsProcess::launch_in_job(
                &executable,
                &arguments,
                self.workspace_file
                    .parent()
                    .expect("editor workspace parent"),
                &job,
            )
            .map_err(|_| {
                "The installed editor could not start within the application lifecycle.".to_string()
            })?;
            Ok(ManagedChild { process, _job: job })
        }
    }

    fn reserve_startup(&self, listener: ListenerAssessment) -> NativeResult<StartupReservation> {
        let mut state = self.lock()?;
        if state.stopped {
            return Ok(StartupReservation::Stopped);
        }
        if state.starting_at.is_some() {
            return Ok(StartupReservation::Starting);
        }
        if state.child.is_some() && state.failure.is_none() {
            // A concurrent health check may have recovered the owned editor
            // since this caller observed a failure. Keep that ready group.
            return Ok(StartupReservation::Ready);
        }
        if state.child.is_none() && listener != ListenerAssessment::Vacant {
            return Ok(StartupReservation::AddressConflict);
        }
        // Only start() after a failed health observation reaches this point.
        // Release exactly the process group this manager owns; a healthy
        // editor and an unrelated address conflict both return earlier.
        state.advance_generation();
        state.child.take();
        state.failure = None;
        state.starting_at = Some(Instant::now());
        Ok(StartupReservation::Reserved(state.generation))
    }

    fn publish_launched_child(&self, generation: u64, child: ManagedChild) -> NativeResult<bool> {
        let mut state = self.lock()?;
        if state.stopped || state.generation != generation || state.starting_at.is_none() {
            // Dropping a stale launch releases only its newly created group;
            // it must not overwrite the child owned by a replacement startup.
            drop(child);
            return Ok(false);
        }
        state.advance_generation();
        state.child = Some(child);
        Ok(true)
    }

    fn record_launch_failure(&self, generation: u64, message: String) -> NativeResult<bool> {
        let mut state = self.lock()?;
        if state.stopped || state.generation != generation || state.starting_at.is_none() {
            return Ok(false);
        }
        state.advance_generation();
        state.starting_at = None;
        state.failure = Some(message);
        Ok(true)
    }

    pub fn stop(&self) {
        if let Ok(mut state) = self.inner.lock() {
            if !state.stopped {
                state.advance_generation();
            }
            state.stopped = true;
            state.starting_at = None;
            state.child.take();
        }
    }
}

fn invalid_workspace(message: &str) -> NativeError {
    NativeError::new("editor_workspace_invalid", message)
}

fn read_bounded_workspace_file(path: &Path) -> NativeResult<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(NativeError::io(
                "the editor workspace cannot be inspected",
                error,
            ))
        }
    };
    if !metadata.is_file() || is_reparse_point(&metadata) || metadata.len() > MAX_WORKSPACE_BYTES {
        return Err(invalid_workspace(
            "The editor workspace metadata is not a regular bounded file",
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_WORKSPACE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| NativeError::io("the editor workspace cannot be read", error))?;
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(invalid_workspace(
            "The editor workspace exceeds its size limit",
        ));
    }
    Ok(Some(bytes))
}

fn atomic_workspace_write(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    atomic_workspace_write_with(path, bytes, |file, bytes| {
        file.write_all(bytes)?;
        file.sync_all()
    })
}

fn atomic_workspace_write_with(
    path: &Path,
    bytes: &[u8],
    write_and_sync: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> NativeResult<()> {
    if bytes.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(invalid_workspace(
            "The editor workspace exceeds its size limit",
        ));
    }
    let parent = path.parent().expect("native-owned editor metadata parent");
    fs::create_dir_all(parent).map_err(|error| {
        NativeError::io("the editor workspace directory cannot be created", error)
    })?;
    let temporary = parent.join(format!("workspace-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| NativeError::io("the editor workspace cannot be created", error))?;
    let written = write_and_sync(&mut file, bytes);
    // Close before replacing on Windows, and clean even when a partial write
    // or flush fails. Publication is allowed only after a successful sync.
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(NativeError::io(
            "the editor workspace could not be written and flushed",
            error,
        ));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(NativeError::io(
            "the editor workspace cannot be replaced",
            error,
        ));
    }
    Ok(())
}

fn json_string_end(bytes: &[u8], start: usize) -> NativeResult<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Ok(index + 1),
            _ => index += 1,
        }
    }
    Err(invalid_workspace(
        "The editor workspace contains an unterminated string",
    ))
}

/// Mask comments and trailing commas without changing byte offsets. The
/// validated JSON is used only to find the folder value; original JSONC and
/// unrelated editor settings/extensions remain byte-for-byte intact.
fn sanitized_workspace_json(source: &str) -> NativeResult<Vec<u8>> {
    let mut bytes = source.as_bytes().to_vec();
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes[..3].fill(b' ');
    }
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            index = json_string_end(&bytes, index)?;
            continue;
        }
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                bytes[index] = b' ';
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            bytes[index..index + 2].fill(b' ');
            index += 2;
            loop {
                if index + 1 >= bytes.len() {
                    return Err(invalid_workspace(
                        "The editor workspace contains an unterminated comment",
                    ));
                }
                if bytes[index..].starts_with(b"*/") {
                    bytes[index..index + 2].fill(b' ');
                    index += 2;
                    break;
                }
                if !matches!(bytes[index], b'\r' | b'\n') {
                    bytes[index] = b' ';
                }
                index += 1;
            }
        } else {
            index += 1;
        }
    }
    index = 0;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            index = json_string_end(&bytes, index)?;
            continue;
        }
        if bytes[index] == b',' {
            let next = bytes[index + 1..]
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace());
            let previous = bytes[..index]
                .iter()
                .copied()
                .rev()
                .find(|byte| !byte.is_ascii_whitespace());
            if matches!(next, Some(b']' | b'}'))
                && !matches!(previous, None | Some(b'[' | b'{' | b',' | b':'))
            {
                bytes[index] = b' ';
            }
        }
        index += 1;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        invalid_workspace(
            "The editor workspace contains invalid JSONC; its settings were kept unchanged",
        )
    })?;
    if !parsed.is_object() {
        return Err(invalid_workspace(
            "The editor workspace must contain a JSONC object",
        ));
    }
    Ok(bytes)
}

fn skip_json_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

fn json_value_end(bytes: &[u8], start: usize) -> NativeResult<usize> {
    if bytes[start] == b'"' {
        return json_string_end(bytes, start);
    }
    if matches!(bytes[start], b'[' | b'{') {
        let mut depth = 0usize;
        let mut index = start;
        while index < bytes.len() {
            match bytes[index] {
                b'"' => {
                    index = json_string_end(bytes, index)?;
                    continue;
                }
                b'[' | b'{' => depth += 1,
                b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(index + 1);
                    }
                }
                _ => {}
            }
            index += 1;
        }
        return Err(invalid_workspace(
            "The editor workspace contains an incomplete value",
        ));
    }
    Ok(bytes[start..]
        .iter()
        .position(|byte| byte.is_ascii_whitespace() || matches!(*byte, b',' | b'}'))
        .map(|end| start + end)
        .unwrap_or(bytes.len()))
}

fn project_native_folders(source: &str, folders: &[EditorFolder]) -> NativeResult<Option<String>> {
    let json = sanitized_workspace_json(source)?;
    let root = skip_json_whitespace(&json, 0);
    let mut index = root + 1;
    let mut folder_range = None;
    while skip_json_whitespace(&json, index) < json.len() {
        index = skip_json_whitespace(&json, index);
        if json[index] == b'}' {
            break;
        }
        let key_end = json_string_end(&json, index)?;
        let key: String = serde_json::from_slice(&json[index..key_end])
            .map_err(|_| invalid_workspace("The editor workspace contains an invalid key"))?;
        let colon = skip_json_whitespace(&json, key_end);
        let value_start = skip_json_whitespace(&json, colon + 1);
        let value_end = json_value_end(&json, value_start)?;
        if key == "folders" {
            if folder_range.is_some() {
                return Err(invalid_workspace(
                    "The editor workspace contains duplicate folder properties",
                ));
            }
            folder_range = Some(value_start..value_end);
        }
        index = skip_json_whitespace(&json, value_end);
        if json.get(index) == Some(&b',') {
            index += 1;
        }
    }
    let expected = serde_json::Value::Array(
        folders
            .iter()
            .map(|folder| serde_json::json!({ "name": folder.name, "path": folder.path }))
            .collect(),
    );
    let parsed: serde_json::Value =
        serde_json::from_slice(&json).expect("validated JSONC projection");
    if parsed.get("folders") == Some(&expected) {
        return Ok(None);
    }
    let replacement = serde_json::to_string_pretty(&expected)
        .map_err(|_| invalid_workspace("The editor folders could not be encoded"))?;
    let mut projected = source.to_owned();
    match folder_range {
        Some(range) => projected.replace_range(range, &replacement),
        None => {
            let comma = if parsed.as_object().expect("validated object").is_empty() {
                ""
            } else {
                ","
            };
            projected.insert_str(
                root + 1,
                &format!("\n  \"folders\": {replacement}{comma}\n"),
            );
        }
    }
    if projected.len() as u64 > MAX_WORKSPACE_BYTES {
        return Err(invalid_workspace(
            "The editor workspace exceeds its size limit",
        ));
    }
    Ok(Some(projected))
}

fn valid_folder_id(value: &str) -> bool {
    value.strip_prefix("editor_").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn picked_folder_record(canonical: &Path) -> EditorFolder {
    EditorFolder {
        id: format!("editor_{}", uuid::Uuid::new_v4().simple()),
        name: canonical
            .file_name()
            .unwrap_or(canonical.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: canonical.to_string_lossy().into_owned(),
    }
}

fn validate_folder(path: &Path) -> NativeResult<PathBuf> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeError::io("the editor folder cannot be inspected", error))?;
    if !path.is_absolute() || !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(NativeError::invalid(
            "folder",
            "must identify a regular local directory",
        ));
    }
    dunce::canonicalize(path)
        .map_err(|error| NativeError::io("the editor folder cannot be resolved", error))
}

fn validate_registered_folder(folder: &EditorFolder) -> NativeResult<PathBuf> {
    let canonical = validate_folder(Path::new(&folder.path)).map_err(|error| {
        NativeError::new(
            "editor_folder_unavailable",
            format!(
                "Editor folder '{}' ({}) at '{}' is unavailable: {}. Remove it from editor folders or select it again",
                folder.name, folder.id, folder.path, error.message,
            ),
        )
    })?;
    if canonical != Path::new(&folder.path) {
        return Err(NativeError::new(
            "editor_folder_changed",
            format!(
                "Editor folder '{}' ({}) at '{}' resolves to a different location. Remove it from editor folders or select it again",
                folder.name, folder.id, folder.path,
            ),
        ));
    }
    Ok(canonical)
}

fn validate_startup_folders(folders: &[EditorFolder]) -> NativeResult<()> {
    for folder in folders {
        validate_registered_folder(folder)?;
    }
    Ok(())
}

fn validate_document(document: &WorkspaceDocument) -> NativeResult<()> {
    if document.folders.len() > MAX_FOLDERS {
        return Err(NativeError::invalid("folders", "too many editor folders"));
    }
    let mut ids = std::collections::HashSet::new();
    for folder in &document.folders {
        if !valid_folder_id(&folder.id)
            || !ids.insert(&folder.id)
            || folder.name.is_empty()
            || folder.name.len() > 1000
            || folder.path.len() > 4000
        {
            return Err(NativeError::new(
                "editor_workspace_invalid",
                "The editor workspace contains invalid folder records",
            ));
        }
        if !Path::new(&folder.path).is_absolute() {
            return Err(NativeError::new(
                "editor_workspace_invalid",
                "The editor workspace contains a relative folder location",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn discover_runtime(home: &Path) -> Option<(PathBuf, Vec<String>)> {
    for installation in [".vscode-insiders", ".vscode", ".vscode-oss"] {
        let cache = home.join(installation).join("cli").join("serve-web");
        let mut candidates = Vec::new();
        if let Ok(entries) = fs::read_dir(cache) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.len() != 40 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    continue;
                }
                let root = entry.path();
                let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
                let main = root.join("out").join("server-main.js");
                if node.is_file() && main.is_file() {
                    let modified = entry
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    candidates.push((modified, node, main));
                }
            }
        }
        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        if let Some((_, node, main)) = candidates.into_iter().next() {
            return Some((node, vec![main.to_string_lossy().into_owned()]));
        }
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let system = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
    for root in [local.join("Programs"), system] {
        for (directory, executable) in [
            ("Microsoft VS Code Insiders", "code-tunnel-insiders.exe"),
            ("Microsoft VS Code", "code-tunnel.exe"),
        ] {
            let cli = root.join(directory).join("bin").join(executable);
            if cli.is_file() {
                return Some((cli, vec!["serve-web".into()]));
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListenerAssessment {
    Vacant,
    Occupied,
    Unavailable,
}

/// Binding is immediate and does not wait for Windows to finish a refused
/// connection. The temporary listener is dropped before any HTTP or launch.
fn assess_listener(address: SocketAddr) -> ListenerAssessment {
    match TcpListener::bind(address) {
        Ok(listener) => {
            drop(listener);
            ListenerAssessment::Vacant
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => ListenerAssessment::Occupied,
        Err(_) => ListenerAssessment::Unavailable,
    }
}

fn editor_socket_address(url: &url::Url) -> Option<SocketAddr> {
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match url.host()? {
        url::Host::Ipv4(address) if address.is_loopback() => Some(SocketAddr::new(
            IpAddr::V4(address),
            url.port_or_known_default()?,
        )),
        _ => None,
    }
}

fn failed_editor_probe(listener: ListenerAssessment) -> (&'static str, Option<String>) {
    match listener {
        ListenerAssessment::Vacant => (
            "unavailable",
            Some("The local editor is not running.".into()),
        ),
        ListenerAssessment::Occupied => ("error", Some("The service at the editor address did not respond. Check port 1430 before retrying.".into())),
        ListenerAssessment::Unavailable => ("error", Some("The local editor address could not be checked. Port 1430 may be reserved or unavailable.".into())),
    }
}

async fn probe_editor(initial_url: &str) -> (&'static str, Option<String>) {
    // The manager constructs this URL from EDITOR_ORIGIN. Keeping the probe
    // helper origin-relative also allows isolated loopback HTTP fixtures.
    let parsed_url = match url::Url::parse(initial_url) {
        Ok(url) => url,
        Err(_) => return ("error", Some("The editor address is invalid.".into())),
    };
    let Some(address) = editor_socket_address(&parsed_url) else {
        return (
            "error",
            Some("The editor address must be local loopback HTTP.".into()),
        );
    };
    let expected_origin = parsed_url.origin().ascii_serialization();
    if assess_listener(address) == ListenerAssessment::Vacant {
        return failed_editor_probe(ListenerAssessment::Vacant);
    }
    let client = match reqwest::Client::builder()
        // A local connection credential must never reach an environment proxy.
        .no_proxy()
        .timeout(Duration::from_millis(1500))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return (
                "error",
                Some("The local editor connection could not be initialized.".into()),
            )
        }
    };
    let mut url = initial_url.to_owned();
    let mut cookies = std::collections::BTreeMap::new();
    for _ in 0..4 {
        let mut request = client.get(&url);
        if !cookies.is_empty() {
            request = request.header(
                reqwest::header::COOKIE,
                cookies
                    .iter()
                    .map(|(key, value)| format!("{key}={value}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            );
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(_) => return failed_editor_probe(assess_listener(address)),
        };
        if response.status().is_redirection() {
            let destination = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|location| url::Url::parse(&url).ok()?.join(location).ok());
            if let Some(destination) = destination
                .filter(|destination| destination.origin().ascii_serialization() == expected_origin)
            {
                for cookie in response
                    .headers()
                    .get_all(reqwest::header::SET_COOKIE)
                    .iter()
                    .filter_map(|value| value.to_str().ok()?.split(';').next())
                    .filter(|value| value.len() < 1024)
                {
                    if let Some((name, value)) = cookie.split_once('=') {
                        if cookies.len() < 16 {
                            cookies.insert(name.to_owned(), value.to_owned());
                        }
                    }
                }
                url = destination.into();
                continue;
            }
            break;
        }
        if !response.status().is_success() {
            break;
        }
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            let remaining = 262_144usize.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if bytes.len() >= 262_144 {
                break;
            }
        }
        let body = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
        if [
            "vscode-workbench",
            "vscode.workbench",
            "workbench.web.main",
            "visual studio code",
        ]
        .iter()
        .any(|marker| body.contains(marker))
        {
            return ("ready", None);
        }
        break;
    }
    ("error", Some("Port 1430 is responding, but it is not a ready VS Code editor. Check the existing service before retrying.".into()))
}

#[cfg(windows)]
struct WindowsJob(windows::Win32::Foundation::HANDLE);
// Job handles may be used and closed from any thread. This wrapper owns its
// unique handle; all child and handle mutation is serialized by ManagerState.
#[cfg(windows)]
unsafe impl Send for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn create() -> windows::core::Result<Self> {
        use windows::Win32::System::JobObjects::*;
        let job = Self(unsafe { CreateJobObjectW(None, None)? });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )?;
        }
        Ok(job)
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// The process is suspended until the job owns it, so even a fast CLI cannot
/// launch an unowned descendant between CreateProcess and job assignment.
#[cfg(windows)]
struct WindowsProcess(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for WindowsProcess {}

#[cfg(windows)]
impl WindowsProcess {
    fn launch_in_job(
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
        job: &WindowsJob,
    ) -> windows::core::Result<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::{PCWSTR, PWSTR},
            Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::AssignProcessToJobObject, Threading::*},
            },
        };
        let executable_wide: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let cwd_wide: Vec<u16> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut command_line: Vec<u16> = std::iter::once(executable.to_string_lossy().into_owned())
            .chain(arguments.iter().cloned())
            .map(|argument| quote_windows_argument(&argument))
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        unsafe {
            CreateProcessW(
                PCWSTR(executable_wide.as_ptr()),
                Some(PWSTR(command_line.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                None,
                PCWSTR(cwd_wide.as_ptr()),
                &startup,
                &mut info,
            )?;
        }
        let process = Self(info.hProcess);
        let activated = unsafe {
            AssignProcessToJobObject(job.0, process.0).and_then(|_| {
                if ResumeThread(info.hThread) == u32::MAX {
                    Err(windows::core::Error::from_win32())
                } else {
                    Ok(())
                }
            })
        };
        let _ = unsafe { CloseHandle(info.hThread) };
        if let Err(error) = activated {
            process.terminate();
            return Err(error);
        }
        Ok(process)
    }

    fn exited(&self) -> bool {
        let mut code = 0;
        unsafe {
            windows::Win32::System::Threading::GetExitCodeProcess(self.0, &mut code).is_err()
                || code != 259
        }
    }

    fn terminate(&self) {
        use windows::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
        if !self.exited() {
            let _ = unsafe { TerminateProcess(self.0, 1) };
            let _ = unsafe { WaitForSingleObject(self.0, 1_000) };
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsProcess {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// Escape one argument for CommandLineToArgvW/MSVC parsing; no shell runs.
fn quote_windows_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        if character == '"' {
            output.extend(std::iter::repeat('\\').take(slashes * 2 + 1));
        } else {
            output.extend(std::iter::repeat('\\').take(slashes));
        }
        slashes = 0;
        output.push(character);
    }
    output.extend(std::iter::repeat('\\').take(slashes * 2));
    output.push('"');
    output
}

fn allowed_local_editor_url(label: &str, url: &url::Url) -> bool {
    let allowed_origin = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) || cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    label == "main"
        && allowed_origin
        && (url.host_str() == Some("127.0.0.1") || url.port().is_none())
}

pub(crate) fn require_local_editor_caller(webview: &Webview) -> NativeResult<()> {
    let url = webview.url().map_err(|_| {
        NativeError::new(
            "editor_caller_denied",
            "The editor request origin is unavailable",
        )
    })?;
    if !allowed_local_editor_url(webview.label(), &url) {
        return Err(NativeError::new(
            "editor_caller_denied",
            "Only the local Omnia window can manage the editor",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn editor_server_status(
    webview: Webview,
    manager: State<'_, EditorServerManager>,
) -> NativeResult<EditorServerStatus> {
    require_local_editor_caller(&webview)?;
    manager.status().await
}

#[tauri::command]
pub async fn editor_server_start(
    webview: Webview,
    manager: State<'_, EditorServerManager>,
) -> NativeResult<EditorServerStatus> {
    require_local_editor_caller(&webview)?;
    manager.start().await
}

#[tauri::command]
pub fn editor_workspace_get(
    webview: Webview,
    manager: State<'_, EditorServerManager>,
) -> NativeResult<EditorWorkspace> {
    require_local_editor_caller(&webview)?;
    manager.workspace()
}

#[tauri::command]
pub async fn editor_workspace_pick(
    webview: Webview,
    manager: State<'_, EditorServerManager>,
) -> NativeResult<EditorWorkspace> {
    require_local_editor_caller(&webview)?;
    let selected = webview
        .dialog()
        .file()
        .set_title("Open folder in the editor")
        .blocking_pick_folder();
    match selected {
        Some(selected) => {
            let path = selected.into_path().map_err(|_| {
                NativeError::new(
                    "editor_folder_invalid",
                    "The selected folder is not a local directory",
                )
            })?;
            manager.apply_picker_selection(Some(&path))
        }
        None => manager.apply_picker_selection(None),
    }
}

#[tauri::command]
pub fn editor_workspace_remove(
    webview: Webview,
    manager: State<'_, EditorServerManager>,
    folder_id: String,
) -> NativeResult<EditorWorkspace> {
    require_local_editor_caller(&webview)?;
    manager.remove_folder(&folder_id)
}

fn editor_uri_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, EditorServerManager) {
        let root =
            std::env::temp_dir().join(format!("omnia-editor-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&root).unwrap();
        (root.clone(), EditorServerManager::new(&root))
    }

    #[test]
    fn own_workspace_starts_empty_and_never_embeds_checkout_defaults() {
        let (root, manager) = fixture();
        let workspace = manager.workspace().unwrap();
        assert!(workspace.folders.is_empty());
        assert_eq!(
            Path::new(&workspace.workspace_path),
            root.join("editor/omnia.code-workspace")
        );
        assert!(!workspace.workspace_path.contains("D:\\Omnia"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn child_document_uses_only_native_selected_ids_and_preserves_encoded_paths_and_token() {
        let (root, manager) = fixture();
        let selected = root.join("đề án #1 & test");
        fs::create_dir(&selected).unwrap();
        let workspace = manager.add_picked_folder(&selected).unwrap();
        let folder = &workspace.folders[0];
        let (url, key) = manager.surface_document(Some(&folder.id)).unwrap();
        assert_eq!(url.origin().ascii_serialization(), EDITOR_ORIGIN);
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "folder")
                .unwrap()
                .1,
            editor_uri_path(&folder.path)
        );
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "tkn")
                .unwrap()
                .1
                .as_ref(),
            manager.connection_token.as_str()
        );
        assert!(url
            .query_pairs()
            .all(|(name, _)| name == "tkn" || name == "folder"));
        assert!(!key.contains(manager.connection_token.as_str()));
        assert!(manager.surface_document(Some("D:\\unselected")).is_err());
        assert!(manager
            .surface_document(Some("editor_0123456789abcdef0123456789abcdef"))
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn child_workspace_document_changes_only_for_actual_native_folder_changes() {
        let (root, manager) = fixture();
        let (empty_url, empty_key) = manager.surface_document(None).unwrap();
        assert_eq!(
            empty_url
                .query_pairs()
                .find(|(name, _)| name == "workspace")
                .unwrap()
                .1,
            editor_uri_path(&manager.workspace().unwrap().workspace_path)
        );
        assert_eq!(empty_key, manager.surface_document(None).unwrap().1);
        let selected = root.join("project");
        fs::create_dir(&selected).unwrap();
        let first = manager.add_picked_folder(&selected).unwrap();
        let chosen_key = manager.surface_document(None).unwrap().1;
        assert_ne!(chosen_key, empty_key);
        manager.add_picked_folder(&selected).unwrap();
        assert_eq!(chosen_key, manager.surface_document(None).unwrap().1);
        manager.remove_folder(&first.folders[0].id).unwrap();
        assert_eq!(empty_key, manager.surface_document(None).unwrap().1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn surface_document_key_tracks_published_editor_generation() {
        let (root, manager) = fixture();
        let (_, empty_key) = manager.surface_document(None).unwrap();

        let StartupReservation::Reserved(first_reservation) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves the first editor generation");
        };
        let (first_child, first_observer) = owned_child_fixture(&root);
        assert!(manager
            .publish_launched_child(first_reservation, first_child)
            .unwrap());
        let (_, first_key) = manager.surface_document(None).unwrap();
        assert_ne!(first_key, empty_key);
        assert_eq!(first_key, manager.surface_document(None).unwrap().1);

        // Mark only this manager-owned group failed, then publish its
        // replacement. The folder set is unchanged, but the document key must
        // force the native surface to navigate to the replacement server.
        {
            let mut state = manager.lock().unwrap();
            // A failed health observation retires the startup deadline before
            // allowing a replacement; a published child alone is still starting.
            state.starting_at = None;
            state.failure = Some("restart fixture".into());
        }
        let StartupReservation::Reserved(replacement_reservation) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves the replacement editor generation");
        };
        let (replacement_child, replacement_observer) = owned_child_fixture(&root);
        assert!(manager
            .publish_launched_child(replacement_reservation, replacement_child)
            .unwrap());
        let (_, replacement_key) = manager.surface_document(None).unwrap();
        assert_ne!(replacement_key, first_key);
        assert_eq!(replacement_key, manager.surface_document(None).unwrap().1);

        manager.stop();
        assert_owned_fixture_stopped(first_observer);
        assert_owned_fixture_stopped(replacement_observer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_records_real_paths_with_opaque_ids_and_preserves_special_characters() {
        let (root, manager) = fixture();
        let selected = root.join("đề án #1 & test");
        fs::create_dir(&selected).unwrap();
        let workspace = manager.add_picked_folder(&selected).unwrap();
        assert_eq!(workspace.folders.len(), 1);
        assert!(valid_folder_id(&workspace.folders[0].id));
        assert_eq!(
            Path::new(&workspace.folders[0].path),
            dunce::canonicalize(selected).unwrap()
        );
        assert_eq!(
            manager
                .add_picked_folder(Path::new(&workspace.folders[0].path))
                .unwrap()
                .folders
                .len(),
            1
        );
        assert_eq!(
            manager.workspace().unwrap().folders[0].id,
            workspace.folders[0].id
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_accepts_only_a_previously_selected_folder_id() {
        let (root, manager) = fixture();
        assert!(manager.remove_folder("C:\\private").is_err());
        let workspace = manager.add_picked_folder(&root).unwrap();
        assert!(manager
            .remove_folder(&format!("editor_{}", "0".repeat(32)))
            .is_err());
        assert!(manager
            .remove_folder(&workspace.folders[0].id)
            .unwrap()
            .folders
            .is_empty());
        assert!(
            root.is_dir(),
            "removing a workspace reference must never delete its folder"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_and_changed_native_workspace_records_fail_closed() {
        let (root, manager) = fixture();
        manager.workspace().unwrap();
        let vendor_before = fs::read(&manager.workspace_file).unwrap();
        fs::write(&manager.registry_file, b"invalid json").unwrap();
        assert!(manager.workspace().is_err());
        fs::write(
            &manager.registry_file,
            serde_json::to_vec(&WorkspaceDocument {
                folders: vec![EditorFolder {
                    id: "path_from_renderer".into(),
                    name: "fake".into(),
                    path: root.to_string_lossy().into(),
                }],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(manager.workspace().is_err());
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), vendor_before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn vendor_jsonc_rewrites_preserve_native_ids_settings_and_selection_authority() {
        let (root, manager) = fixture();
        let selected = root.join("picked project");
        let unselected = root.join("unpicked project");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(&unselected).unwrap();
        let first = manager.add_picked_folder(&selected).unwrap();
        let registry_before = fs::read(&manager.registry_file).unwrap();
        let vendor_folders = serde_json::json!([
            { "name": "vendor rename", "path": first.folders[0].path },
            { "path": unselected.to_string_lossy() },
        ]);
        let settings = r#""settings": {
    // Keep // and /* inside strings, escaped quotes and nested folders.
    "example.url": "https://example.test/a/*b*/?q=\"[x]\"",
    "example.nested": {"folders": ["vendor setting",],},
  },
  "extensions": {"recommendations": ["vendor.extension",],},"#;
        let source = format!(
            "\u{feff}{{\n  /* workspace comment */\n  \"folders\": {vendor_folders},\n  {settings}\n}}\n"
        );
        fs::write(&manager.workspace_file, source.as_bytes()).unwrap();

        let rewritten = manager.workspace().unwrap();
        assert_eq!(rewritten.folders.len(), 1);
        assert_eq!(rewritten.folders[0].id, first.folders[0].id);
        assert_eq!(rewritten.folders[0].path, first.folders[0].path);
        assert_eq!(fs::read(&manager.registry_file).unwrap(), registry_before);
        let projected = fs::read_to_string(&manager.workspace_file).unwrap();
        assert!(projected.starts_with('\u{feff}'));
        assert!(projected.contains("/* workspace comment */"));
        assert!(projected.contains(settings));
        let json: serde_json::Value =
            serde_json::from_slice(&sanitized_workspace_json(&projected).unwrap()).unwrap();
        assert_eq!(json["folders"].as_array().unwrap().len(), 1);
        assert_eq!(json["folders"][0]["path"], first.folders[0].path);
        assert!(json["folders"][0].get("id").is_none());
        assert_eq!(
            EditorServerManager::new(&root).workspace().unwrap().folders[0].id,
            first.folders[0].id
        );
        manager.remove_folder(&first.folders[0].id).unwrap();
        assert!(fs::read_to_string(&manager.workspace_file)
            .unwrap()
            .contains(settings));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn previous_native_records_migrate_without_losing_vendor_settings() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let folder = EditorFolder {
            id: "editor_0123456789abcdef0123456789abcdef".into(),
            name: "previous native pick".into(),
            path: dunce::canonicalize(&root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        };
        let folders = serde_json::to_string(&vec![folder.clone()]).unwrap();
        let source = format!(
            "{{\n  // Previous native file\n  \"folders\": {folders},\n  \"settings\": {{\"editor.fontSize\": 17,}},\n}}\n"
        );
        fs::write(&manager.workspace_file, source).unwrap();
        let migrated = manager.workspace().unwrap();
        assert_eq!(migrated.folders[0].id, folder.id);
        assert!(manager.registry_file.is_file());
        let vendor = fs::read_to_string(&manager.workspace_file).unwrap();
        assert!(vendor.contains("// Previous native file"));
        assert!(vendor.contains("\"settings\": {\"editor.fontSize\": 17,}"));
        assert!(!vendor.contains(&folder.id));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standard_vendor_paths_without_native_registry_never_become_selected_folders() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let vendor = serde_json::to_vec(&serde_json::json!({
            "folders": [{ "path": root.to_string_lossy() }],
            "settings": { "editor.fontSize": 17 },
        }))
        .unwrap();
        fs::write(&manager.workspace_file, &vendor).unwrap();
        assert!(manager.workspace().is_err());
        assert!(!manager.registry_file.exists());
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), vendor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_native_pick_recovers_vendor_only_workspace_with_original_bytes_backed_up() {
        let (root, manager) = fixture();
        let selected = root.join("fresh native choice");
        let old = root.join("old untrusted folder");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(&old).unwrap();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let vendor_folders = serde_json::json!([
            { "path": old.to_string_lossy() },
            { "name": "untrusted relative", "path": "../unselected" },
        ]);
        let settings = "  // Keep settings and extension selection\n  \"settings\": {\"editor.fontSize\": 19,},\n  \"extensions\": {\"recommendations\": [\"vendor.extension\",],},";
        let source = format!("\u{feff}{{\n  \"folders\": {vendor_folders},\n{settings}\n}}\n");
        fs::write(&manager.workspace_file, source.as_bytes()).unwrap();
        assert!(manager.workspace().is_err());
        assert!(manager.apply_picker_selection(None).is_err());
        assert_eq!(
            fs::read(&manager.workspace_file).unwrap(),
            source.as_bytes()
        );
        assert!(!manager.registry_file.exists());
        let backup_dir = manager
            .workspace_file
            .parent()
            .unwrap()
            .join("workspace-backups");
        assert!(
            !backup_dir.exists(),
            "read or picker cancellation cannot create a recovery backup"
        );

        let picked = manager.apply_picker_selection(Some(&selected)).unwrap();
        assert_eq!(picked.folders.len(), 1);
        assert_eq!(
            Path::new(&picked.folders[0].path),
            dunce::canonicalize(&selected).unwrap()
        );
        assert!(valid_folder_id(&picked.folders[0].id));
        let backup_paths = fs::read_dir(&backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(backup_paths.len(), 1);
        assert_eq!(fs::read(&backup_paths[0]).unwrap(), source.as_bytes());
        let projected = fs::read_to_string(&manager.workspace_file).unwrap();
        assert!(projected.starts_with('\u{feff}'));
        assert!(projected.contains(settings));
        let projected_json: serde_json::Value =
            serde_json::from_slice(&sanitized_workspace_json(&projected).unwrap()).unwrap();
        assert_eq!(projected_json["folders"].as_array().unwrap().len(), 1);
        assert_eq!(projected_json["folders"][0]["path"], picked.folders[0].path);
        let read = EditorServerManager::new(&root).workspace().unwrap();
        assert_eq!(read.folders[0].id, picked.folders[0].id);
        assert!(manager
            .surface_document(Some(&picked.folders[0].id))
            .is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_recovers_settings_only_and_uri_workspaces_without_granting_vendor_folders() {
        for source in [
            "{\n  // Preserve settings without a folders property\n  \"settings\": {\"editor.fontSize\": 21,},\n}\n",
            "{\"folders\": [{\"uri\": \"vscode-vfs://untrusted/remote\", \"name\": \"remote\"}], \"settings\": {\"editor.fontSize\": 21}}",
            "{\"folders\": [], \"settings\": {\"editor.fontSize\": 21}}",
        ] {
            let (root, manager) = fixture();
            let selected = root.join("new native selection");
            fs::create_dir(&selected).unwrap();
            fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
            fs::write(&manager.workspace_file, source).unwrap();
            let picked = manager.apply_picker_selection(Some(&selected)).unwrap();
            assert_eq!(picked.folders.len(), 1);
            assert_eq!(Path::new(&picked.folders[0].path), dunce::canonicalize(&selected).unwrap());
            assert!(valid_folder_id(&picked.folders[0].id));
            let backup_dir = manager.workspace_file.parent().unwrap().join("workspace-backups");
            let backups = fs::read_dir(backup_dir).unwrap().map(|entry| entry.unwrap().path()).collect::<Vec<_>>();
            assert_eq!(backups.len(), 1);
            assert_eq!(fs::read(&backups[0]).unwrap(), source.as_bytes());
            let projected = fs::read_to_string(&manager.workspace_file).unwrap();
            let json: serde_json::Value = serde_json::from_slice(&sanitized_workspace_json(&projected).unwrap()).unwrap();
            assert_eq!(json["settings"]["editor.fontSize"], 21);
            assert_eq!(json["folders"].as_array().unwrap().len(), 1);
            assert_eq!(json["folders"][0]["path"], picked.folders[0].path);
            assert!(json["folders"][0].get("uri").is_none());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn mixed_native_and_vendor_recovery_reports_missing_registry_and_preserves_original() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let source = serde_json::to_vec(&serde_json::json!({
            "folders": [
                {"id": "editor_0123456789abcdef0123456789abcdef", "name": "legacy", "path": root.to_string_lossy()},
                {"path": "../untrusted"},
            ],
            "settings": {"keep": true},
        })).unwrap();
        fs::write(&manager.workspace_file, &source).unwrap();
        let error = manager
            .apply_picker_selection(Some(&root))
            .err()
            .expect("mixed authority must fail closed");
        assert_eq!(error.code, "editor_workspace_invalid");
        assert!(error.message.contains("mixes native folder records"));
        assert!(error.message.contains("folders.json backup"));
        assert!(!manager.registry_file.exists());
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), source);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_recovery_refuses_corrupt_native_registry_and_invalid_vendor_jsonc() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let valid_vendor = serde_json::to_vec(&serde_json::json!({
            "folders": [{ "path": root.to_string_lossy() }],
            "settings": { "keep": true },
        }))
        .unwrap();
        fs::write(&manager.workspace_file, &valid_vendor).unwrap();
        fs::write(&manager.registry_file, b"corrupt native authority").unwrap();
        assert!(manager.apply_picker_selection(Some(&root)).is_err());
        assert_eq!(
            fs::read(&manager.registry_file).unwrap(),
            b"corrupt native authority"
        );
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), valid_vendor);
        fs::remove_file(&manager.registry_file).unwrap();
        for invalid in [
            "{\"folders\": [{\"path\": \"old\"}], \"settings\": {\"keep\": true,",
            "{\"folders\": [{\"path\": \"old\"}], \"folders\": [{\"path\": \"other\"}]}",
            "{\"folders\": [{\"id\": \"corrupt-native-id\", \"name\": \"old\", \"path\": \"old\"}]}",
        ] {
            fs::write(&manager.workspace_file, invalid).unwrap();
            assert!(manager.apply_picker_selection(Some(&root)).is_err());
            assert!(!manager.registry_file.exists());
            assert_eq!(fs::read_to_string(&manager.workspace_file).unwrap(), invalid);
        }
        assert!(!manager
            .workspace_file
            .parent()
            .unwrap()
            .join("workspace-backups")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_recovery_requires_durable_backup_before_changing_authority_or_projection() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let vendor = b"{\"folders\": [{\"path\": \"../old\"}], \"settings\": {\"keep\": true}}";
        fs::write(&manager.workspace_file, vendor).unwrap();
        let backup_dir = manager
            .workspace_file
            .parent()
            .unwrap()
            .join("workspace-backups");
        fs::write(&backup_dir, b"fixture prevents a backup directory").unwrap();
        assert!(manager.apply_picker_selection(Some(&root)).is_err());
        assert!(!manager.registry_file.exists());
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), vendor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_recovery_can_authorize_an_identical_standard_vendor_projection() {
        let (root, manager) = fixture();
        fs::create_dir_all(manager.workspace_file.parent().unwrap()).unwrap();
        let canonical = dunce::canonicalize(&root).unwrap();
        let folder = picked_folder_record(&canonical);
        let vendor = serde_json::to_vec(&serde_json::json!({
            "folders": [{ "name": folder.name, "path": folder.path }],
            "settings": { "keep": true },
        }))
        .unwrap();
        fs::write(&manager.workspace_file, &vendor).unwrap();
        let picked = manager.apply_picker_selection(Some(&root)).unwrap();
        assert_eq!(picked.folders.len(), 1);
        assert!(valid_folder_id(&picked.folders[0].id));
        assert_eq!(fs::read(&manager.workspace_file).unwrap(), vendor);
        assert!(manager.registry_file.is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_vendor_jsonc_preserves_bytes_and_durable_native_registry() {
        let (root, manager) = fixture();
        let picked = manager.add_picked_folder(&root).unwrap();
        let registry_before = fs::read(&manager.registry_file).unwrap();
        for invalid in [
            "{\"folders\": [], \"settings\": {\"keep\": true,",
            "{\"folders\": [], \"folders\": [], \"settings\": {\"keep\": true}}",
            "{\"folders\": [], /* unterminated settings comment",
        ] {
            fs::write(&manager.workspace_file, invalid).unwrap();
            assert!(manager.workspace().is_err());
            assert!(manager.remove_folder(&picked.folders[0].id).is_err());
            assert_eq!(fs::read(&manager.registry_file).unwrap(), registry_before);
            assert_eq!(
                fs::read_to_string(&manager.workspace_file).unwrap(),
                invalid
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_vendor_projection_is_regenerated_from_native_registry() {
        let (root, manager) = fixture();
        let picked = manager.add_picked_folder(&root).unwrap();
        let registry_before = fs::read(&manager.registry_file).unwrap();
        fs::remove_file(&manager.workspace_file).unwrap();
        let restored = manager.workspace().unwrap();
        assert_eq!(restored.folders[0].id, picked.folders[0].id);
        assert_eq!(fs::read(&manager.registry_file).unwrap(), registry_before);
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(&manager.workspace_file).unwrap()).unwrap();
        assert_eq!(json["folders"][0]["path"], picked.folders[0].path);
        assert!(json["folders"][0].get("id").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn jsonc_projection_inserts_missing_folders_and_preserves_other_values() {
        for source in [
            "{ /* keep an empty workspace comment */ }\n",
            "{\n  // Keep settings\n  \"settings\": {\"nested\": {\"folders\": [1,],},},\n}\n",
            "{\"settings\": {\"text\": \"// /* [ \\\"quoted\\\" ] */\"}}",
        ] {
            let projected = project_native_folders(source, &[]).unwrap().unwrap();
            let before: serde_json::Value =
                serde_json::from_slice(&sanitized_workspace_json(source).unwrap()).unwrap();
            let after: serde_json::Value =
                serde_json::from_slice(&sanitized_workspace_json(&projected).unwrap()).unwrap();
            assert_eq!(after["settings"], before["settings"]);
            assert_eq!(after["folders"], serde_json::json!([]));
            assert!(project_native_folders(&projected, &[]).unwrap().is_none());
        }
    }

    #[test]
    fn discovers_complete_cache_without_a_pinned_version() {
        let (root, _) = fixture();
        let incomplete = root
            .join(".vscode-insiders/cli/serve-web")
            .join("a".repeat(40));
        let complete = root
            .join(".vscode-insiders/cli/serve-web")
            .join("b".repeat(40));
        fs::create_dir_all(&incomplete).unwrap();
        fs::create_dir_all(complete.join("out")).unwrap();
        let node = complete.join(if cfg!(windows) { "node.exe" } else { "node" });
        fs::write(&node, b"fixture").unwrap();
        fs::write(complete.join("out/server-main.js"), b"fixture").unwrap();
        let (command, args) = discover_runtime(&root).unwrap();
        assert_eq!(command, node);
        assert_eq!(args.len(), 1);
        assert_eq!(
            Path::new(&args[0]),
            complete.join("out").join("server-main.js")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renderer_status_never_serializes_native_connection_credentials() {
        let (root, manager) = fixture();
        for state in ["ready", "starting", "unavailable", "error"] {
            let status = manager.status_value(state, Some("Editor status fixture".into()));
            let serialized = serde_json::to_string(&status).unwrap();
            assert!(
                !serialized.contains(manager.connection_token.as_str()),
                "native connection token must not appear in renderer status"
            );
            let public_url = url::Url::parse(&status.url).unwrap();
            assert_eq!(public_url.origin().ascii_serialization(), EDITOR_ORIGIN);
            assert!(public_url.query().is_none());
            assert!(public_url.username().is_empty());
            assert!(public_url.password().is_none());
            assert!(public_url.fragment().is_none());
            assert_eq!(public_url.path(), "/");
        }

        let private_url = url::Url::parse(&manager.editor_url()).unwrap();
        let (child_url, child_key) = manager.surface_document(None).unwrap();
        for url in [&private_url, &child_url] {
            assert!(url.query_pairs().any(|(name, value)| {
                name == "tkn" && value.as_ref() == manager.connection_token.as_str()
            }));
        }
        assert!(!child_key.contains(manager.connection_token.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn editor_url_has_only_fixed_loopback_origin_and_ephemeral_token() {
        let (root, manager) = fixture();
        let url = url::Url::parse(&manager.editor_url()).unwrap();
        assert_eq!(url.origin().ascii_serialization(), EDITOR_ORIGIN);
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "tkn")
                .unwrap()
                .1
                .len(),
            32
        );
        assert_ne!(
            manager.editor_url(),
            EditorServerManager::new(&root).editor_url()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_workspace_write_cleans_partial_write_and_flush_failures_before_publication() {
        for flush_failure in [false, true] {
            let (root, manager) = fixture();
            let target = &manager.workspace_file;
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, b"original target").unwrap();
            let result = atomic_workspace_write_with(target, b"replacement", |file, bytes| {
                file.write_all(if flush_failure { bytes } else { &bytes[..3] })?;
                assert_eq!(fs::read(target)?, b"original target");
                Err(std::io::Error::other(if flush_failure {
                    "injected sync failure"
                } else {
                    "injected partial write failure"
                }))
            });
            assert!(result.is_err());
            assert_eq!(fs::read(target).unwrap(), b"original target");
            assert!(fs::read_dir(target.parent().unwrap())
                .unwrap()
                .all(|entry| entry
                    .unwrap()
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "tmp")));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn atomic_workspace_write_publishes_only_after_writer_and_sync_complete() {
        let (root, manager) = fixture();
        let target = &manager.workspace_file;
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, b"original target").unwrap();
        let mut completed = false;
        atomic_workspace_write_with(target, b"replacement", |file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()?;
            assert_eq!(fs::read(target)?, b"original target");
            completed = true;
            Ok(())
        })
        .unwrap();
        assert!(completed);
        assert_eq!(fs::read(target).unwrap(), b"replacement");
        fs::remove_file(target).unwrap();
        fs::create_dir(target).unwrap();
        assert!(atomic_workspace_write(target, b"cannot replace a directory").is_err());
        assert!(target.is_dir());
        assert!(fs::read_dir(target.parent().unwrap())
            .unwrap()
            .all(|entry| entry
                .unwrap()
                .path()
                .extension()
                .is_none_or(|extension| extension != "tmp")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_folder_can_still_be_removed_without_touching_other_folders() {
        let (root, manager) = fixture();
        let selected = root.join("later-removed");
        fs::create_dir(&selected).unwrap();
        let workspace = manager.add_picked_folder(&selected).unwrap();
        fs::remove_dir(&selected).unwrap();
        assert_eq!(manager.workspace().unwrap().folders.len(), 1);
        assert!(manager
            .remove_folder(&workspace.folders[0].id)
            .unwrap()
            .folders
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_validation_identifies_the_unavailable_registered_root_and_recovery() {
        let (root, manager) = fixture();
        let live = root.join("live");
        let missing = root.join("missing");
        fs::create_dir(&live).unwrap();
        fs::create_dir(&missing).unwrap();
        let first = manager.add_picked_folder(&live).unwrap();
        let workspace = manager.add_picked_folder(&missing).unwrap();
        let unavailable = &workspace.folders[1];
        fs::remove_dir(&missing).unwrap();
        let error = validate_startup_folders(&workspace.folders).unwrap_err();
        assert_eq!(error.code, "editor_folder_unavailable");
        assert!(error.message.contains(&unavailable.id));
        assert!(error.message.contains(&unavailable.path));
        assert!(error
            .message
            .contains("Remove it from editor folders or select it again"));
        let recovered = manager.remove_folder(&unavailable.id).unwrap();
        assert_eq!(recovered.folders.len(), 1);
        assert_eq!(recovered.folders[0].id, first.folders[0].id);
        validate_startup_folders(&recovered.folders).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_arguments_quote_spaces_quotes_and_trailing_backslashes_without_a_shell() {
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(
            quote_windows_argument("path with spaces"),
            "\"path with spaces\""
        );
        assert_eq!(quote_windows_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_windows_argument("C:\\folder\\"), "\"C:\\folder\\\\\"");
        assert_eq!(quote_windows_argument("$() & #"), "\"$() & #\"");
    }

    fn one_response_server(response: &'static str) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let _ = socket.read(&mut bytes);
            let _ = socket.write_all(response.as_bytes());
        });
        format!("http://{address}/")
    }

    #[tokio::test]
    async fn health_requires_editor_html_and_rejects_foreign_redirects() {
        let ready = one_response_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nvscode-workbench",
        );
        assert_eq!(probe_editor(&ready).await.0, "ready");
        let conflict = one_response_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
        );
        assert_eq!(probe_editor(&conflict).await.0, "error");
        let redirect = one_response_server("HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://example.com/\r\nConnection: close\r\n\r\n");
        assert_eq!(probe_editor(&redirect).await.0, "error");
    }

    #[test]
    fn concurrent_startup_reservations_coalesce_and_stop_cannot_be_restarted() {
        let (root, manager) = fixture();
        let handles = (0..16)
            .map(|_| {
                let manager = manager.clone();
                std::thread::spawn(move || {
                    manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let reservations = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            reservations
                .iter()
                .filter(|&&result| matches!(result, StartupReservation::Reserved(_)))
                .count(),
            1
        );
        assert_eq!(
            reservations
                .iter()
                .filter(|&&result| result == StartupReservation::Starting)
                .count(),
            15
        );
        assert!(manager.lock().unwrap().starting_at.is_some());
        manager.stop();
        assert!(manager.lock().unwrap().starting_at.is_none());
        assert_eq!(
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap(),
            StartupReservation::Stopped
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_owned_failure_never_authorizes_an_unknown_listener_or_reserved_address() {
        let (root, manager) = fixture();
        manager.lock().unwrap().failure = Some("A previous owned process failed".into());
        for assessment in [
            ListenerAssessment::Occupied,
            ListenerAssessment::Unavailable,
        ] {
            assert_eq!(
                manager.reserve_startup(assessment).unwrap(),
                StartupReservation::AddressConflict
            );
            let state = manager.lock().unwrap();
            assert!(state.child.is_none());
            assert!(state.starting_at.is_none());
            assert!(state.failure.is_some());
        }
        assert!(matches!(
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap(),
            StartupReservation::Reserved(_)
        ));
        assert!(manager.lock().unwrap().failure.is_none());
        manager.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_late_launcher_failure_cannot_overwrite_the_replacement_generation() {
        let (root, manager) = fixture();
        let StartupReservation::Reserved(first) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves the first generation");
        };
        assert!(manager
            .record_launch_failure(first, "first launch failed".into())
            .unwrap());
        let StartupReservation::Reserved(replacement) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves its replacement");
        };
        let deadline = manager.lock().unwrap().starting_at;
        assert!(replacement > first);
        assert!(!manager
            .record_launch_failure(first, "stale launcher failed".into())
            .unwrap());
        {
            let state = manager.lock().unwrap();
            assert_eq!(state.generation, replacement);
            assert_eq!(state.starting_at, deadline);
            assert!(state.failure.is_none());
        }
        manager.stop();
        assert!(!manager
            .record_launch_failure(replacement, "stopped launcher failed".into())
            .unwrap());
        assert!(manager.lock().unwrap().failure.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_delayed_unowned_probe_cannot_apply_its_error_to_a_replacement_startup() {
        let (root, manager) = fixture();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let checking = manager.clone();
        let check = tokio::spawn(async move {
            checking
                .status_with_probe(|url| async move {
                    assert!(!url.contains("tkn="));
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    ("error", Some("stale foreign listener result".into()))
                })
                .await
                .unwrap()
        });
        entered_rx.await.unwrap();
        let StartupReservation::Reserved(replacement) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves its new startup");
        };
        let deadline = manager.lock().unwrap().starting_at;
        release_tx.send(()).unwrap();
        assert_eq!(check.await.unwrap().state, "starting");
        {
            let state = manager.lock().unwrap();
            assert_eq!(state.generation, replacement);
            assert_eq!(state.starting_at, deadline);
            assert!(state.failure.is_none());
        }
        manager.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn vacant_socket_is_unavailable_even_when_a_previous_http_probe_timed_out() {
        let temporary = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = temporary.local_addr().unwrap();
        drop(temporary);
        assert_eq!(assess_listener(address), ListenerAssessment::Vacant);
        // HTTP timeout and connect errors use the same socket assessment;
        // neither error type is evidence that another service owns the port.
        assert_eq!(
            failed_editor_probe(assess_listener(address)).0,
            "unavailable"
        );
        let observation = tokio::time::timeout(
            Duration::from_millis(500),
            probe_editor(&format!("http://{address}/")),
        )
        .await
        .expect("a vacant address must not wait for an HTTP connection timeout");
        assert_eq!(observation.0, "unavailable");
    }

    #[tokio::test]
    async fn occupied_unresponsive_listener_remains_a_conflict_and_is_not_adopted() {
        let (root, manager) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let assessment = assess_listener(address);
        assert_ne!(assessment, ListenerAssessment::Vacant);
        let observation = probe_editor(&format!("http://{address}/")).await;
        assert_eq!(observation.0, "error");
        assert_eq!(
            manager.reserve_startup(assess_listener(address)).unwrap(),
            StartupReservation::AddressConflict
        );
        assert!(manager.lock().unwrap().child.is_none());
        assert_eq!(listener.local_addr().unwrap(), address);
        drop(listener);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn health_socket_addresses_are_literal_loopback_http_without_user_credentials() {
        for value in [
            "https://127.0.0.1:1430/",
            "http://example.com:1430/",
            "http://192.0.2.1:1430/",
            "http://user:secret@127.0.0.1:1430/",
        ] {
            assert!(editor_socket_address(&url::Url::parse(value).unwrap()).is_none());
        }
        assert_eq!(
            editor_socket_address(&url::Url::parse(EDITOR_ORIGIN).unwrap()).unwrap(),
            "127.0.0.1:1430".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn caller_gate_accepts_only_main_local_app_origins() {
        for value in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(allowed_local_editor_url(
                "main",
                &url::Url::parse(value).unwrap()
            ));
            assert!(!allowed_local_editor_url(
                "remote",
                &url::Url::parse(value).unwrap()
            ));
        }
        for value in [
            "https://example.com/",
            "http://127.0.0.1:1430/",
            "http://localhost:1420/",
            "https://tauri.localhost.example.com/",
            "http://tauri.localhost:1430/",
        ] {
            assert!(!allowed_local_editor_url(
                "main",
                &url::Url::parse(value).unwrap()
            ));
        }
    }

    fn read_fixture_http_head(reader: &mut impl Read) -> std::io::Result<String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut head = Vec::new();
        loop {
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "fixture HTTP header deadline",
                ));
            }
            let remaining = 16_384usize.saturating_sub(head.len());
            if remaining == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture HTTP header exceeds 16 KiB",
                ));
            }
            let mut chunk = [0; 512];
            let limit = remaining.min(chunk.len());
            let count = reader.read(&mut chunk[..limit])?;
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "fixture HTTP header incomplete",
                ));
            }
            head.extend_from_slice(&chunk[..count]);
            if let Some(end) = head.windows(4).position(|part| part == b"\r\n\r\n") {
                return String::from_utf8(head[..end + 4].to_vec()).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "fixture HTTP header is not UTF-8",
                    )
                });
            }
        }
    }

    #[test]
    fn fixture_http_head_handles_fragmentation_and_rejects_incomplete_or_oversized() {
        struct Fragmented<'a>(&'a [u8]);
        impl Read for Fragmented<'_> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let limit = output.len().min(7);
                self.0.read(&mut output[..limit])
            }
        }
        let request = b"GET /entry HTTP/1.1\r\nCookie: vscode-tkn=fixture\r\n\r\n";
        assert_eq!(
            read_fixture_http_head(&mut Fragmented(request)).unwrap(),
            String::from_utf8_lossy(request)
        );
        assert_eq!(
            read_fixture_http_head(&mut &request[..request.len() - 1])
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            read_fixture_http_head(&mut &vec![b'x'; 16_385][..])
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn authenticated_health_preserves_cookies_across_same_origin_redirects() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for step in 0..3 {
                let accept_deadline = Instant::now() + Duration::from_secs(3);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < accept_deadline,
                                "redirect step {step}: no request before accept deadline"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("redirect step {step}: accept failed: {error}"),
                    }
                };
                // Windows accepted sockets can inherit the listener's mode.
                // The header reader uses blocking reads with a finite timeout.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let head = read_fixture_http_head(&mut socket)
                    .unwrap_or_else(|error| panic!("redirect step {step}: {error}"));
                let expected_path = ["/?tkn=fixture", "/entry", "/workbench"][step];
                assert_eq!(
                    head.lines().next(),
                    Some(format!("GET {expected_path} HTTP/1.1").as_str()),
                    "redirect step {step}: unexpected request line"
                );
                if step > 0 {
                    assert!(
                        head.lines().filter_map(|line| line.split_once(':')).any(
                            |(name, value)| name.eq_ignore_ascii_case("cookie")
                                && value.split(';').any(|pair| pair.trim() == "vscode-tkn=fixture")
                        ),
                        "redirect step {step}: complete request has no expected Cookie header; names={:?}",
                        head.lines()
                            .skip(1)
                            .filter_map(|line| line.split_once(':').map(|(name, _)| name))
                            .collect::<Vec<_>>()
                    );
                }
                let response = match step {
                    0 => "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nSet-Cookie: vscode-tkn=fixture; HttpOnly\r\nLocation: /entry\r\nConnection: close\r\n\r\n",
                    1 => "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: /workbench\r\nConnection: close\r\n\r\n",
                    _ => "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\nvscode-workbench",
                };
                socket.write_all(response.as_bytes()).unwrap();
            }
        });
        let result = probe_editor(&format!("http://{address}/?tkn=fixture")).await;
        server.join().unwrap();
        assert_eq!(result.0, "ready", "{:?}", result.1);
    }

    #[cfg(windows)]
    fn owned_child_fixture(root: &Path) -> (ManagedChild, windows::Win32::Foundation::HANDLE) {
        use windows::Win32::System::Threading::*;
        let command =
            PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system directory"))
                .join("System32/cmd.exe");
        let job = WindowsJob::create().unwrap();
        let process = WindowsProcess::launch_in_job(
            &command,
            &["/D".into(), "/C".into(), "ping -n 60 127.0.0.1 >NUL".into()],
            root,
            &job,
        )
        .unwrap();
        let observer = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                GetProcessId(process.0),
            )
            .unwrap()
        };
        (ManagedChild { process, _job: job }, observer)
    }

    #[cfg(windows)]
    fn assert_owned_fixture_stopped(observer: windows::Win32::Foundation::HANDLE) {
        use windows::Win32::{Foundation::CloseHandle, System::Threading::WaitForSingleObject};
        let waited = unsafe { WaitForSingleObject(observer, 3_000) };
        let _ = unsafe { CloseHandle(observer) };
        assert_eq!(
            waited.0, 0,
            "only this fixture's owned group must be terminated"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn delayed_owned_ready_and_error_observations_preserve_replacement_lifecycle() {
        for observation in ["ready", "error"] {
            let (root, manager) = fixture();
            let StartupReservation::Reserved(first) =
                manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
            else {
                panic!("fixture reserves its first startup");
            };
            let (child, first_observer) = owned_child_fixture(&root);
            assert!(manager.publish_launched_child(first, child).unwrap());
            assert_eq!(
                manager
                    .status_with_probe(|_| async { ("ready", None) })
                    .await
                    .unwrap()
                    .state,
                "ready"
            );
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let checking = manager.clone();
            let check = tokio::spawn(async move {
                checking
                    .status_with_probe(|url| async move {
                        assert!(url.contains("tkn="));
                        entered_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        (observation, None)
                    })
                    .await
                    .unwrap()
            });
            entered_rx.await.unwrap();
            manager.lock().unwrap().failure = Some("replace the failed owned generation".into());
            let StartupReservation::Reserved(replacement) = manager
                .reserve_startup(ListenerAssessment::Occupied)
                .unwrap()
            else {
                panic!("fixture reserves its replacement startup");
            };
            let replacement_observer = if observation == "error" {
                let (child, observer) = owned_child_fixture(&root);
                assert!(manager.publish_launched_child(replacement, child).unwrap());
                assert_eq!(
                    manager
                        .status_with_probe(|_| async { ("ready", None) })
                        .await
                        .unwrap()
                        .state,
                    "ready"
                );
                Some(observer)
            } else {
                None
            };
            let expected = {
                let state = manager.lock().unwrap();
                (
                    state.generation,
                    state.starting_at,
                    state.failure.clone(),
                    state.child.is_some(),
                )
            };
            release_tx.send(()).unwrap();
            assert_eq!(check.await.unwrap().state, "starting");
            {
                let state = manager.lock().unwrap();
                assert_eq!(state.generation, expected.0);
                assert_eq!(state.starting_at, expected.1);
                assert_eq!(state.failure, expected.2);
                assert_eq!(state.child.is_some(), expected.3);
            }
            assert_owned_fixture_stopped(first_observer);
            manager.stop();
            if let Some(observer) = replacement_observer {
                assert_owned_fixture_stopped(observer);
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_late_successful_launcher_releases_its_group_without_overwriting_replacement() {
        let (root, manager) = fixture();
        let StartupReservation::Reserved(first) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves the first generation");
        };
        assert!(manager
            .record_launch_failure(first, "first launch timed out".into())
            .unwrap());
        let StartupReservation::Reserved(replacement) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves its replacement");
        };
        let deadline = manager.lock().unwrap().starting_at;
        let (stale_child, observer) = owned_child_fixture(&root);
        assert!(!manager.publish_launched_child(first, stale_child).unwrap());
        {
            let state = manager.lock().unwrap();
            assert_eq!(state.generation, replacement);
            assert_eq!(state.starting_at, deadline);
            assert!(state.child.is_none());
            assert!(state.failure.is_none());
        }
        assert_owned_fixture_stopped(observer);
        manager.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn startup_failure_cannot_overwrite_a_child_published_by_the_same_reservation() {
        let (root, manager) = fixture();
        let StartupReservation::Reserved(generation) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves its startup");
        };
        let (child, observer) = owned_child_fixture(&root);
        assert!(manager.publish_launched_child(generation, child).unwrap());
        let published_generation = manager.lock().unwrap().generation;
        assert!(published_generation > generation);
        assert!(!manager
            .record_launch_failure(generation, "late duplicated failure".into())
            .unwrap());
        {
            let state = manager.lock().unwrap();
            assert_eq!(state.generation, published_generation);
            assert!(state.child.is_some());
            assert!(state.starting_at.is_some());
            assert!(state.failure.is_none());
        }
        manager.stop();
        assert_owned_fixture_stopped(observer);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn delayed_ready_requires_the_same_owned_process_to_still_be_alive() {
        use windows::Win32::System::Threading::TerminateProcess;
        let (root, manager) = fixture();
        let StartupReservation::Reserved(generation) =
            manager.reserve_startup(ListenerAssessment::Vacant).unwrap()
        else {
            panic!("fixture reserves its startup");
        };
        let (child, observer) = owned_child_fixture(&root);
        assert!(manager.publish_launched_child(generation, child).unwrap());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let checking = manager.clone();
        let check = tokio::spawn(async move {
            checking
                .status_with_probe(|_| async move {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    ("ready", None)
                })
                .await
                .unwrap()
        });
        entered_rx.await.unwrap();
        {
            let state = manager.lock().unwrap();
            unsafe { TerminateProcess(state.child.as_ref().unwrap().process.0, 1) }.unwrap();
        }
        assert_owned_fixture_stopped(observer);
        release_tx.send(()).unwrap();
        assert_eq!(check.await.unwrap().state, "error");
        {
            let state = manager.lock().unwrap();
            assert!(state.child.is_none());
            assert!(state.starting_at.is_none());
            assert!(state.failure.as_ref().unwrap().contains("process stopped"));
        }
        manager.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn retry_replaces_only_a_failed_owned_group_and_keeps_a_recovered_group() {
        use windows::Win32::{Foundation::CloseHandle, System::Threading::*};
        let (root, manager) = fixture();
        let command =
            PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system directory"))
                .join("System32/cmd.exe");
        let job = WindowsJob::create().unwrap();
        let process = WindowsProcess::launch_in_job(
            &command,
            &["/D".into(), "/C".into(), "ping -n 60 127.0.0.1 >NUL".into()],
            &root,
            &job,
        )
        .unwrap();
        let observer = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                GetProcessId(process.0),
            )
            .unwrap()
        };
        manager.lock().unwrap().child = Some(ManagedChild { process, _job: job });
        assert_eq!(
            manager
                .reserve_startup(ListenerAssessment::Occupied)
                .unwrap(),
            StartupReservation::Ready,
            "a concurrent recovered observation must retain the healthy owned group"
        );
        assert!(manager.lock().unwrap().child.is_some());
        assert_eq!(unsafe { WaitForSingleObject(observer, 0) }.0, 258);

        manager.lock().unwrap().failure = Some("The owned fixture stopped responding".into());
        assert!(matches!(
            manager
                .reserve_startup(ListenerAssessment::Occupied)
                .unwrap(),
            StartupReservation::Reserved(_)
        ));
        {
            let state = manager.lock().unwrap();
            assert!(state.child.is_none());
            assert!(state.starting_at.is_some());
            assert!(state.failure.is_none());
        }
        let waited = unsafe { WaitForSingleObject(observer, 3_000) };
        let _ = unsafe { CloseHandle(observer) };
        assert_eq!(waited.0, 0, "retry must terminate the owned process group");
        manager.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_owned_job_stops_its_real_hidden_descendant_process() {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        #[repr(C)]
        struct ProcessIds {
            assigned: u32,
            listed: u32,
            ids: [usize; 16],
        }
        let command =
            PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system directory"))
                .join("System32/cmd.exe");
        let job = WindowsJob::create().unwrap();
        let process = WindowsProcess::launch_in_job(
            &command,
            &["/D".into(), "/C".into(), "ping -n 60 127.0.0.1 >NUL".into()],
            &std::env::temp_dir(),
            &job,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant = loop {
            let mut list = ProcessIds {
                assigned: 0,
                listed: 0,
                ids: [0; 16],
            };
            unsafe {
                QueryInformationJobObject(
                    Some(job.0),
                    JobObjectBasicProcessIdList,
                    &mut list as *mut _ as *mut std::ffi::c_void,
                    std::mem::size_of_val(&list) as u32,
                    None,
                )
                .unwrap();
            }
            if list.listed >= 2 {
                let parent_id = unsafe { GetProcessId(process.0) };
                let descendant_id = list.ids[..list.listed as usize]
                    .iter()
                    .copied()
                    .find(|id| *id as u32 != parent_id)
                    .unwrap();
                break unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        false,
                        descendant_id as u32,
                    )
                    .unwrap()
                };
            }
            assert!(
                Instant::now() < deadline,
                "the hidden fixture should launch a descendant"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        drop(job);
        let waited = unsafe { WaitForSingleObject(descendant, 3_000) };
        let _ = unsafe { CloseHandle(descendant) };
        assert_eq!(waited.0, 0, "closing the job must terminate its descendant");
        assert!(process.exited());
    }
}
