use std::{path::Path, sync::Arc};

use dashmap::DashMap;
use tokio::sync::watch;

use crate::{
    app_state_persistence::AppStateSnapshotStore,
    attachment_repository::AttachmentRepository,
    blob_key_broker::{BlobKeyBroker, DEFAULT_BLOB_PROFILE_SCOPE},
    content_store::ContentStore,
    download_manager::DownloadManager,
    error::NativeResult,
    ipc_session::CoreSessionRegistry,
    isolated_input::IsolatedInputBroker,
    project_file_pointers::ProjectFilePointerRepository,
    provider_gateway::ProviderGateway,
    secret_store::SecretBroker,
    settings_permissions_persistence::SettingsPermissionsSnapshotStore,
    storage::Storage,
};

pub struct AppState {
    pub run_cancellations: Arc<DashMap<String, watch::Sender<bool>>>,
    pub storage: Storage,
    /// Renderer composition state is intentionally kept in a small separate
    /// JSON store.  The SQLite database remains authoritative for durable
    /// domain records; this field only owns the renderer snapshot boundary.
    pub app_state: AppStateSnapshotStore,
    /// Durable settings and permission policy snapshot.  This is separate
    /// from the renderer composition snapshot so policy writes use their own
    /// compare-and-swap revision and cannot overwrite chat state.
    pub settings_permissions: SettingsPermissionsSnapshotStore,
    pub secrets: SecretBroker,
    pub blob_keys: BlobKeyBroker,
    pub content_store: ContentStore,
    /// Native broker-fed download queue. Raw browser request material remains
    /// outside the renderer and is represented only by opaque receipt ids.
    pub downloads: DownloadManager,
    /// Lease-bound isolated input registry. It is inert when no detached
    /// platform backend is available and never falls back to global input.
    pub isolated_input: IsolatedInputBroker,
    pub attachments: AttachmentRepository,
    pub provider_gateway: ProviderGateway,
    /// Native project-file pointer catalog. Source identities and encrypted
    /// snapshot bodies remain outside renderer composition state.
    pub project_file_pointers: ProjectFilePointerRepository,
}

impl AppState {
    pub fn initialize(app_data_dir: &Path) -> NativeResult<Self> {
        // Initialize the fail-closed protected key broker before opening the
        // content store. A profile with missing key metadata must never create
        // a replacement key over existing encrypted data.
        let blob_keys = BlobKeyBroker::initialize(app_data_dir, DEFAULT_BLOB_PROFILE_SCOPE)?;
        let content_store = ContentStore::open(app_data_dir)?;
        Ok(Self {
            run_cancellations: Arc::new(DashMap::new()),
            storage: Storage::open(app_data_dir.join("omnia.sqlite3"))?,
            app_state: AppStateSnapshotStore::open(app_data_dir)?,
            settings_permissions: SettingsPermissionsSnapshotStore::open(app_data_dir)?,
            secrets: SecretBroker,
            blob_keys,
            content_store,
            downloads: DownloadManager::new(),
            isolated_input: IsolatedInputBroker::default(),
            attachments: AttachmentRepository::new(),
            provider_gateway: ProviderGateway::new()?,
            project_file_pointers: ProjectFilePointerRepository::open(app_data_dir)?,
        })
    }
}

pub fn initialize_core_session_registry() -> CoreSessionRegistry {
    CoreSessionRegistry::default()
}
