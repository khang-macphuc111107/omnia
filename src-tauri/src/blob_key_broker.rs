use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use aes_gcm::{
    aead::{Aead, Nonce, Payload},
    Aes256Gcm, KeyInit,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    content_store::BlobKeyProvider,
    error::{NativeError, NativeResult},
};

#[cfg(windows)]
use keyring::{Entry, Error as KeyringError};

pub const DEFAULT_BLOB_PROFILE_SCOPE: &str = "profile_default";

const WINDOWS_VAULT_SERVICE: &str = "ai.omnia.desktop.blob-key";
const METADATA_DIRECTORY: &str = "security";
const METADATA_FILE: &str = "blob-key-broker.json";
const METADATA_FORMAT_VERSION: u32 = 1;
const CURRENT_KEY_VERSION: i64 = 1;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_KEY_SLOTS: usize = 16;
const MASTER_KEY_BYTES: usize = 32;
const WRAP_NONCE_BYTES: usize = 12;
const WRAPPED_DEK_BYTES: usize = 32 + 16;
const WRAPPED_DEK_MAGIC: &[u8; 8] = b"OMNIADEK";
const WRAPPED_DEK_FORMAT_VERSION: u8 = 1;
const WRAPPED_DEK_ALGORITHM_AES_256_GCM: u8 = 1;
const WRAPPED_DEK_HEADER_BYTES: usize = 8 + 1 + 1 + 2 + 8;
const WRAPPED_DEK_ENVELOPE_BYTES: usize =
    WRAPPED_DEK_HEADER_BYTES + WRAP_NONCE_BYTES + WRAPPED_DEK_BYTES;
const MAX_BLOB_SCAN_ENTRIES: usize = 4_096;

/// Wraps blob data-encryption keys with a profile key protected by the host
/// operating system. Raw profile keys are loaded only for a single operation
/// and are zeroized on a best-effort basis immediately afterwards.
///
/// The broker deliberately has no plaintext or machine-local file fallback.
/// If protected storage cannot be reached, blob reads and writes fail closed.
pub struct BlobKeyBroker {
    profile_scope: String,
    metadata: BlobKeyMetadata,
    vault: Arc<dyn ProtectedKeyVault>,
}

impl BlobKeyBroker {
    /// Opens the production key broker. On Windows, key material is stored as
    /// a binary Generic Credential protected by Windows Credential Manager.
    /// Other platforms remain unavailable until they have an equivalently
    /// reviewed protected-storage implementation.
    pub fn initialize(app_data_dir: &Path, profile_scope: &str) -> NativeResult<Self> {
        #[cfg(windows)]
        {
            Self::initialize_with_vault(
                app_data_dir,
                profile_scope,
                Arc::new(WindowsProtectedKeyVault),
            )
        }

        #[cfg(not(windows))]
        {
            let _ = (app_data_dir, profile_scope);
            Err(NativeError::new(
                "blob_key_platform_unsupported",
                "Encrypted blob storage requires a supported operating-system key vault",
            ))
        }
    }

    fn initialize_with_vault(
        app_data_dir: &Path,
        profile_scope: &str,
        vault: Arc<dyn ProtectedKeyVault>,
    ) -> NativeResult<Self> {
        validate_profile_scope(profile_scope)?;
        let paths = BrokerPaths::prepare(app_data_dir)?;

        if paths.metadata.exists() {
            return Self::load_existing(paths.metadata, profile_scope, vault);
        }

        // A missing vault descriptor is safe to initialize only before any
        // encrypted content exists. Generating a replacement for an existing
        // profile would make all prior blobs permanently unreadable.
        if encrypted_content_exists(&paths.app_data_dir)? {
            return Err(NativeError::new(
                "blob_key_recovery_required",
                "Encrypted content exists but its protected key metadata is missing",
            ));
        }

        let candidate = BlobKeyMetadata::new(profile_scope);
        let slot = candidate.current_slot()?;
        let mut master_key = Zeroizing::new([0_u8; MASTER_KEY_BYTES]);
        getrandom::fill(master_key.as_mut()).map_err(|_| {
            NativeError::new(
                "randomness_unavailable",
                "Operating-system secure randomness is unavailable for blob-key creation",
            )
        })?;
        vault.write(&slot.credential_ref, &master_key)?;

        let published = match publish_metadata(&paths, &candidate) {
            Ok(published) => published,
            Err(error) => {
                let _ = vault.delete(&slot.credential_ref);
                return Err(error);
            }
        };

        if published {
            let persisted_key = vault.read(&slot.credential_ref)?.ok_or_else(|| {
                NativeError::new(
                    "blob_key_missing",
                    "Windows protected storage did not retain the new blob key",
                )
            })?;
            if persisted_key.as_ref() != master_key.as_ref() {
                return Err(NativeError::new(
                    "blob_key_vault_failed",
                    "Windows protected storage returned an inconsistent blob key",
                ));
            }
            return Ok(Self {
                profile_scope: profile_scope.to_owned(),
                metadata: candidate,
                vault,
            });
        }

        // Another Omnia process won the atomic metadata publication race. Its
        // key is authoritative; remove our unreferenced credential and load
        // the published descriptor instead.
        vault.delete(&slot.credential_ref)?;
        Self::load_existing(paths.metadata, profile_scope, vault)
    }

    fn load_existing(
        metadata_path: PathBuf,
        profile_scope: &str,
        vault: Arc<dyn ProtectedKeyVault>,
    ) -> NativeResult<Self> {
        let metadata = read_metadata(&metadata_path)?;
        metadata.validate(profile_scope)?;
        let broker = Self {
            profile_scope: profile_scope.to_owned(),
            metadata,
            vault,
        };
        // Validate every declared key version, not only the current writer
        // key. Otherwise startup could appear healthy while older blobs have
        // already become irrecoverable.
        for slot in &broker.metadata.keys {
            if broker.vault.read(&slot.credential_ref)?.is_none() {
                return Err(NativeError::new(
                    "blob_key_missing",
                    format!(
                        "Blob-key version {} is missing from Windows protected storage",
                        slot.key_version
                    ),
                ));
            }
        }
        Ok(broker)
    }

    fn slot_for_version(&self, key_version: i64) -> NativeResult<&BlobKeySlot> {
        self.metadata
            .keys
            .iter()
            .find(|slot| slot.key_version == key_version)
            .ok_or_else(|| {
                NativeError::new(
                    "blob_key_version_unavailable",
                    "The requested blob-key version is not available in this profile",
                )
            })
    }

    fn load_master_key(&self, slot: &BlobKeySlot) -> NativeResult<Zeroizing<[u8; 32]>> {
        self.vault.read(&slot.credential_ref)?.ok_or_else(|| {
            NativeError::new(
                "blob_key_missing",
                "A required blob key is missing from Windows protected storage",
            )
        })
    }

    fn wrapping_aad(&self, slot: &BlobKeySlot) -> Vec<u8> {
        let mut aad = Vec::with_capacity(32 + self.profile_scope.len() + slot.credential_ref.len());
        aad.extend_from_slice(b"omnia/blob-dek-wrap");
        aad.push(0);
        aad.push(WRAPPED_DEK_FORMAT_VERSION);
        aad.extend_from_slice(&slot.key_version.to_be_bytes());
        aad.extend_from_slice(&(self.profile_scope.len() as u16).to_be_bytes());
        aad.extend_from_slice(self.profile_scope.as_bytes());
        aad.extend_from_slice(&(slot.credential_ref.len() as u16).to_be_bytes());
        aad.extend_from_slice(slot.credential_ref.as_bytes());
        aad
    }
}

impl BlobKeyProvider for BlobKeyBroker {
    fn current_key_version(&self) -> NativeResult<i64> {
        // Validate the slot again so corrupted in-memory construction can
        // never cause an unversioned wrap operation.
        self.metadata.current_slot()?;
        Ok(self.metadata.current_key_version)
    }

    fn wrap_dek(&self, key_version: i64, dek: &[u8; 32]) -> NativeResult<Vec<u8>> {
        if key_version != self.metadata.current_key_version {
            return Err(NativeError::new(
                "blob_key_version_not_current",
                "New blobs can only use the profile's current key version",
            ));
        }
        let slot = self.slot_for_version(key_version)?;
        let master_key = self.load_master_key(slot)?;
        let cipher = Aes256Gcm::new_from_slice(master_key.as_ref()).map_err(|_| {
            NativeError::new(
                "blob_key_wrap_failed",
                "Could not initialize blob-key wrapping",
            )
        })?;
        let mut nonce = [0_u8; WRAP_NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| {
            NativeError::new(
                "randomness_unavailable",
                "Operating-system secure randomness is unavailable for blob-key wrapping",
            )
        })?;
        let nonce = Nonce::<Aes256Gcm>::from(nonce);
        let mut ciphertext = Zeroizing::new(
            cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: dek,
                        aad: &self.wrapping_aad(slot),
                    },
                )
                .map_err(|_| {
                    NativeError::new("blob_key_wrap_failed", "Could not wrap the blob key")
                })?,
        );
        if ciphertext.len() != WRAPPED_DEK_BYTES {
            return Err(NativeError::new(
                "blob_key_wrap_failed",
                "Blob-key wrapping returned an invalid envelope size",
            ));
        }

        let mut envelope = Vec::with_capacity(WRAPPED_DEK_ENVELOPE_BYTES);
        envelope.extend_from_slice(WRAPPED_DEK_MAGIC);
        envelope.push(WRAPPED_DEK_FORMAT_VERSION);
        envelope.push(WRAPPED_DEK_ALGORITHM_AES_256_GCM);
        envelope.extend_from_slice(&[0, 0]);
        envelope.extend_from_slice(&key_version.to_be_bytes());
        envelope.extend_from_slice(nonce.as_slice());
        envelope.extend_from_slice(ciphertext.as_slice());
        ciphertext.zeroize();
        Ok(envelope)
    }

    fn unwrap_dek(
        &self,
        key_version: i64,
        wrapped_dek: &[u8],
    ) -> NativeResult<Zeroizing<[u8; 32]>> {
        let parsed = ParsedEnvelope::parse(key_version, wrapped_dek)?;
        let slot = self.slot_for_version(key_version)?;
        let master_key = self.load_master_key(slot)?;
        let cipher = Aes256Gcm::new_from_slice(master_key.as_ref()).map_err(|_| {
            NativeError::new(
                "blob_key_unwrap_failed",
                "Could not initialize blob-key unwrapping",
            )
        })?;
        let nonce = Nonce::<Aes256Gcm>::try_from(parsed.nonce).map_err(|_| {
            NativeError::new(
                "blob_key_envelope_invalid",
                "The wrapped blob-key envelope has an invalid nonce length",
            )
        })?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce,
                    Payload {
                        msg: parsed.ciphertext,
                        aad: &self.wrapping_aad(slot),
                    },
                )
                .map_err(|_| {
                    NativeError::new(
                        "blob_key_unwrap_failed",
                        "The wrapped blob key failed authentication",
                    )
                })?,
        );
        if plaintext.len() != MASTER_KEY_BYTES {
            return Err(NativeError::new(
                "blob_key_unwrap_failed",
                "The unwrapped blob key has an invalid length",
            ));
        }
        let mut dek = Zeroizing::new([0_u8; MASTER_KEY_BYTES]);
        dek.copy_from_slice(plaintext.as_slice());
        Ok(dek)
    }
}

struct ParsedEnvelope<'a> {
    nonce: &'a [u8],
    ciphertext: &'a [u8],
}

impl<'a> ParsedEnvelope<'a> {
    fn parse(expected_key_version: i64, envelope: &'a [u8]) -> NativeResult<Self> {
        if envelope.len() != WRAPPED_DEK_ENVELOPE_BYTES
            || &envelope[..8] != WRAPPED_DEK_MAGIC
            || envelope[8] != WRAPPED_DEK_FORMAT_VERSION
            || envelope[9] != WRAPPED_DEK_ALGORITHM_AES_256_GCM
            || envelope[10] != 0
            || envelope[11] != 0
        {
            return Err(NativeError::new(
                "blob_key_envelope_invalid",
                "The wrapped blob-key envelope is malformed or unsupported",
            ));
        }
        let encoded_key_version =
            i64::from_be_bytes(envelope[12..20].try_into().map_err(|_| {
                NativeError::new("blob_key_envelope_invalid", "Invalid key version")
            })?);
        if encoded_key_version != expected_key_version {
            return Err(NativeError::new(
                "blob_key_envelope_invalid",
                "The wrapped blob-key version does not match its descriptor",
            ));
        }
        Ok(Self {
            nonce: &envelope[WRAPPED_DEK_HEADER_BYTES..WRAPPED_DEK_HEADER_BYTES + WRAP_NONCE_BYTES],
            ciphertext: &envelope[WRAPPED_DEK_HEADER_BYTES + WRAP_NONCE_BYTES..],
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlobKeyMetadata {
    format_version: u32,
    profile_scope: String,
    current_key_version: i64,
    keys: Vec<BlobKeySlot>,
}

impl BlobKeyMetadata {
    fn new(profile_scope: &str) -> Self {
        Self {
            format_version: METADATA_FORMAT_VERSION,
            profile_scope: profile_scope.to_owned(),
            current_key_version: CURRENT_KEY_VERSION,
            keys: vec![BlobKeySlot {
                key_version: CURRENT_KEY_VERSION,
                credential_ref: format!("blob_key_{}", Uuid::new_v4().simple()),
            }],
        }
    }

    fn validate(&self, expected_profile_scope: &str) -> NativeResult<()> {
        if self.format_version != METADATA_FORMAT_VERSION {
            return Err(NativeError::new(
                "blob_key_metadata_unsupported",
                "The blob-key metadata format is not supported by this build",
            ));
        }
        if self.profile_scope != expected_profile_scope {
            return Err(NativeError::new(
                "blob_key_scope_mismatch",
                "The blob-key metadata belongs to a different Omnia profile",
            ));
        }
        validate_profile_scope(&self.profile_scope)?;
        if self.keys.is_empty() || self.keys.len() > MAX_KEY_SLOTS {
            return Err(invalid_key_metadata());
        }
        let mut versions = HashSet::with_capacity(self.keys.len());
        for slot in &self.keys {
            if slot.key_version <= 0
                || !versions.insert(slot.key_version)
                || !valid_credential_ref(&slot.credential_ref)
            {
                return Err(invalid_key_metadata());
            }
        }
        if self.keys.iter().map(|slot| slot.key_version).max() != Some(self.current_key_version) {
            return Err(invalid_key_metadata());
        }
        self.current_slot()?;
        Ok(())
    }

    fn current_slot(&self) -> NativeResult<&BlobKeySlot> {
        self.keys
            .iter()
            .find(|slot| slot.key_version == self.current_key_version)
            .ok_or_else(invalid_key_metadata)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlobKeySlot {
    key_version: i64,
    credential_ref: String,
}

fn invalid_key_metadata() -> NativeError {
    NativeError::new(
        "blob_key_metadata_invalid",
        "The blob-key metadata is malformed or internally inconsistent",
    )
}

fn validate_profile_scope(profile_scope: &str) -> NativeResult<()> {
    let valid = !profile_scope.is_empty()
        && profile_scope.len() <= 128
        && profile_scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(NativeError::invalid(
            "profileScope",
            "must be a bounded portable identifier",
        ))
    }
}

fn valid_credential_ref(reference: &str) -> bool {
    reference.strip_prefix("blob_key_").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

trait ProtectedKeyVault: Send + Sync {
    fn read(&self, credential_ref: &str) -> NativeResult<Option<Zeroizing<[u8; 32]>>>;
    fn write(&self, credential_ref: &str, key: &[u8; 32]) -> NativeResult<()>;
    fn delete(&self, credential_ref: &str) -> NativeResult<bool>;
}

#[cfg(windows)]
struct WindowsProtectedKeyVault;

#[cfg(windows)]
impl WindowsProtectedKeyVault {
    fn entry(credential_ref: &str) -> NativeResult<Entry> {
        if !valid_credential_ref(credential_ref) {
            return Err(invalid_key_metadata());
        }
        Entry::new(WINDOWS_VAULT_SERVICE, credential_ref).map_err(|_| {
            NativeError::new(
                "blob_key_vault_unavailable",
                "Windows Credential Manager is unavailable for blob-key protection",
            )
        })
    }
}

#[cfg(windows)]
impl ProtectedKeyVault for WindowsProtectedKeyVault {
    fn read(&self, credential_ref: &str) -> NativeResult<Option<Zeroizing<[u8; 32]>>> {
        let secret = match Self::entry(credential_ref)?.get_secret() {
            Ok(secret) => Zeroizing::new(secret),
            Err(KeyringError::NoEntry) => return Ok(None),
            Err(error) => return Err(map_vault_read_error(error)),
        };
        if secret.len() != MASTER_KEY_BYTES {
            return Err(NativeError::new(
                "blob_key_vault_invalid",
                "Windows protected storage returned malformed blob-key material",
            ));
        }
        let mut key = Zeroizing::new([0_u8; MASTER_KEY_BYTES]);
        key.copy_from_slice(secret.as_slice());
        Ok(Some(key))
    }

    fn write(&self, credential_ref: &str, key: &[u8; 32]) -> NativeResult<()> {
        Self::entry(credential_ref)?
            .set_secret(key)
            .map_err(map_vault_write_error)
    }

    fn delete(&self, credential_ref: &str) -> NativeResult<bool> {
        match Self::entry(credential_ref)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(map_vault_write_error(error)),
        }
    }
}

#[cfg(windows)]
fn map_vault_write_error(error: KeyringError) -> NativeError {
    match error {
        KeyringError::NoStorageAccess(_) => NativeError::retryable(
            "blob_key_vault_locked",
            "Windows Credential Manager is locked or unavailable",
        ),
        _ => NativeError::new(
            "blob_key_vault_failed",
            "Windows Credential Manager rejected the blob-key operation",
        ),
    }
}

#[cfg(windows)]
fn map_vault_read_error(error: KeyringError) -> NativeError {
    match error {
        KeyringError::NoStorageAccess(_) => NativeError::retryable(
            "blob_key_vault_locked",
            "Windows Credential Manager is locked or unavailable",
        ),
        _ => NativeError::new(
            "blob_key_vault_failed",
            "Windows Credential Manager could not read the protected blob key",
        ),
    }
}

struct BrokerPaths {
    app_data_dir: PathBuf,
    security_dir: PathBuf,
    metadata: PathBuf,
}

impl BrokerPaths {
    fn prepare(app_data_dir: &Path) -> NativeResult<Self> {
        fs::create_dir_all(app_data_dir).map_err(|error| {
            NativeError::io(
                "could not create the Omnia application-data directory",
                error,
            )
        })?;
        let app_data_dir = dunce::canonicalize(app_data_dir).map_err(|error| {
            NativeError::io(
                "could not resolve the Omnia application-data directory",
                error,
            )
        })?;
        let requested_security_dir = app_data_dir.join(METADATA_DIRECTORY);
        match fs::create_dir(&requested_security_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(NativeError::io(
                    "could not create the blob-key metadata directory",
                    error,
                ));
            }
        }
        let requested_metadata =
            fs::symlink_metadata(&requested_security_dir).map_err(|error| {
                NativeError::io("could not inspect the blob-key metadata directory", error)
            })?;
        if !requested_metadata.is_dir() || is_reparse_point(&requested_metadata) {
            return Err(NativeError::new(
                "blob_key_path_unsafe",
                "The blob-key metadata directory is not a regular local directory",
            ));
        }
        let security_dir = dunce::canonicalize(&requested_security_dir).map_err(|error| {
            NativeError::io("could not resolve the blob-key metadata directory", error)
        })?;
        if !security_dir.starts_with(&app_data_dir) {
            return Err(NativeError::new(
                "blob_key_path_unsafe",
                "The blob-key metadata directory resolves outside the Omnia profile",
            ));
        }
        Ok(Self {
            metadata: security_dir.join(METADATA_FILE),
            app_data_dir,
            security_dir,
        })
    }
}

fn publish_metadata(paths: &BrokerPaths, metadata: &BlobKeyMetadata) -> NativeResult<bool> {
    let serialized = serde_json::to_vec_pretty(metadata).map_err(|_| {
        NativeError::new(
            "blob_key_metadata_failed",
            "Could not encode the blob-key metadata",
        )
    })?;
    if serialized.len() as u64 > MAX_METADATA_BYTES {
        return Err(invalid_key_metadata());
    }
    let temporary_path = paths
        .security_dir
        .join(format!(".{METADATA_FILE}.{}.tmp", Uuid::new_v4().simple()));
    let mut temporary = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| NativeError::io("could not create blob-key metadata", error))?;
    let write_result = (|| {
        temporary
            .write_all(&serialized)
            .map_err(|error| NativeError::io("could not write blob-key metadata", error))?;
        temporary
            .sync_all()
            .map_err(|error| NativeError::io("could not flush blob-key metadata", error))?;
        Ok(())
    })();
    drop(temporary);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    let published = match fs::hard_link(&temporary_path, &paths.metadata) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(NativeError::io(
                "could not atomically publish blob-key metadata",
                error,
            ));
        }
    };
    // Once the hard link is published, the descriptor is authoritative. A
    // temporary-link cleanup failure must not be reported as publication
    // failure: the initializer would otherwise delete the credential that the
    // already-published metadata references, making the profile unrecoverable.
    let _ = fs::remove_file(&temporary_path);
    sync_directory(&paths.security_dir);
    Ok(published)
}

fn read_metadata(path: &Path) -> NativeResult<BlobKeyMetadata> {
    let lexical_metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => NativeError::new(
            "blob_key_metadata_missing",
            "The blob-key metadata is missing",
        ),
        _ => NativeError::io("could not inspect blob-key metadata", error),
    })?;
    if !lexical_metadata.is_file() || is_reparse_point(&lexical_metadata) {
        return Err(NativeError::new(
            "blob_key_metadata_invalid",
            "The blob-key metadata is not a bounded regular file",
        ));
    }
    let file = open_metadata_without_following_final_reparse_point(path)
        .map_err(|error| NativeError::io("could not open blob-key metadata", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| NativeError::io("could not inspect open blob-key metadata", error))?;
    if !metadata.is_file() || is_reparse_point(&metadata) || metadata.len() > MAX_METADATA_BYTES {
        return Err(NativeError::new(
            "blob_key_metadata_invalid",
            "The blob-key metadata is not a bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| NativeError::io("could not read blob-key metadata", error))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(NativeError::new(
            "blob_key_metadata_invalid",
            "The blob-key metadata changed while it was being read",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_key_metadata())
}

fn open_metadata_without_following_final_reparse_point(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn encrypted_content_exists(app_data_dir: &Path) -> NativeResult<bool> {
    if sqlite_references_blobs(&app_data_dir.join("omnia.sqlite3"))? {
        return Ok(true);
    }
    directory_contains_file(&app_data_dir.join("blobs"))
}

fn sqlite_references_blobs(database_path: &Path) -> NativeResult<bool> {
    if !database_path.exists() {
        return Ok(false);
    }
    let metadata = fs::symlink_metadata(database_path)
        .map_err(|error| NativeError::io("could not inspect the Omnia database", error))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(NativeError::new(
            "blob_key_state_unknown",
            "The Omnia database is not a safe regular file",
        ));
    }
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| {
        NativeError::new(
            "blob_key_state_unknown",
            "The Omnia database could not be checked before blob-key creation",
        )
    })?;
    let table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blob_objects')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| {
            NativeError::new(
                "blob_key_state_unknown",
                "The Omnia database schema could not be checked before blob-key creation",
            )
        })?;
    if !table_exists {
        return Ok(false);
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM blob_objects LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|_| {
            NativeError::new(
                "blob_key_state_unknown",
                "Existing blob metadata could not be checked before key creation",
            )
        })
}

fn directory_contains_file(root: &Path) -> NativeResult<bool> {
    if !root.exists() {
        return Ok(false);
    }
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| NativeError::io("could not inspect the encrypted blob store", error))?;
    if !root_metadata.is_dir() || is_reparse_point(&root_metadata) {
        return Err(NativeError::new(
            "blob_key_state_unknown",
            "The encrypted blob store is not a safe local directory",
        ));
    }
    let mut pending = vec![root.to_path_buf()];
    let mut inspected = 0_usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| NativeError::io("could not inspect the encrypted blob store", error))?
        {
            let entry = entry.map_err(|error| {
                NativeError::io("could not inspect an encrypted blob path", error)
            })?;
            inspected += 1;
            if inspected > MAX_BLOB_SCAN_ENTRIES {
                return Err(NativeError::new(
                    "blob_key_state_unknown",
                    "The encrypted blob store is too large to safely inspect for key recovery",
                ));
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                NativeError::io("could not inspect an encrypted blob path", error)
            })?;
            if is_reparse_point(&metadata) {
                return Err(NativeError::new(
                    "blob_key_state_unknown",
                    "The encrypted blob store contains an unsafe reparse point",
                ));
            }
            if metadata.is_file() {
                return Ok(true);
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(false)
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct MemoryVault {
        keys: Mutex<HashMap<String, [u8; 32]>>,
        available: Mutex<bool>,
    }

    impl MemoryVault {
        fn available() -> Self {
            Self {
                keys: Mutex::new(HashMap::new()),
                available: Mutex::new(true),
            }
        }

        fn remove(&self, credential_ref: &str) {
            self.keys.lock().unwrap().remove(credential_ref);
        }

        fn set_available(&self, available: bool) {
            *self.available.lock().unwrap() = available;
        }

        fn check_available(&self) -> NativeResult<()> {
            if *self.available.lock().unwrap() {
                Ok(())
            } else {
                Err(NativeError::retryable(
                    "blob_key_vault_locked",
                    "The test vault is locked",
                ))
            }
        }
    }

    impl ProtectedKeyVault for MemoryVault {
        fn read(&self, credential_ref: &str) -> NativeResult<Option<Zeroizing<[u8; 32]>>> {
            self.check_available()?;
            Ok(self
                .keys
                .lock()
                .unwrap()
                .get(credential_ref)
                .copied()
                .map(Zeroizing::new))
        }

        fn write(&self, credential_ref: &str, key: &[u8; 32]) -> NativeResult<()> {
            self.check_available()?;
            self.keys
                .lock()
                .unwrap()
                .insert(credential_ref.to_owned(), *key);
            Ok(())
        }

        fn delete(&self, credential_ref: &str) -> NativeResult<bool> {
            self.check_available()?;
            Ok(self.keys.lock().unwrap().remove(credential_ref).is_some())
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "omnia-blob-key-broker-{label}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn initializes_once_and_reopens_the_same_protected_key() {
        let root = temporary_directory("initialize");
        let vault = Arc::new(MemoryVault::available());
        let first =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
                .unwrap();
        let dek = [0x41; 32];
        let envelope = first.wrap_dek(1, &dek).unwrap();

        let reopened =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault).unwrap();
        assert_eq!(reopened.unwrap_dek(1, &envelope).unwrap().as_ref(), &dek);

        let metadata =
            fs::read_to_string(root.join(METADATA_DIRECTORY).join(METADATA_FILE)).unwrap();
        assert!(!metadata.contains("41414141"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn wrapping_is_randomized_and_bound_to_profile_version_and_credential() {
        let root = temporary_directory("binding");
        let vault = Arc::new(MemoryVault::available());
        let broker =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault).unwrap();
        let dek = [0x2a; 32];
        let first = broker.wrap_dek(1, &dek).unwrap();
        let second = broker.wrap_dek(1, &dek).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.len(), WRAPPED_DEK_ENVELOPE_BYTES);
        assert_eq!(broker.unwrap_dek(1, &first).unwrap().as_ref(), &dek);

        let mut wrong_version = first.clone();
        wrong_version[19] = 2;
        assert_eq!(
            broker.unwrap_dek(1, &wrong_version).unwrap_err().code,
            "blob_key_envelope_invalid"
        );

        let mut tampered = first;
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            broker.unwrap_dek(1, &tampered).unwrap_err().code,
            "blob_key_unwrap_failed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_locked_vault_fails_closed_without_replacement() {
        let root = temporary_directory("fail-closed");
        let vault = Arc::new(MemoryVault::available());
        let broker =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
                .unwrap();
        let credential_ref = broker
            .metadata
            .current_slot()
            .unwrap()
            .credential_ref
            .clone();
        vault.remove(&credential_ref);
        assert_eq!(
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone(),)
                .err()
                .unwrap()
                .code,
            "blob_key_missing"
        );
        assert!(vault.keys.lock().unwrap().is_empty());

        vault.set_available(false);
        assert_eq!(
            broker.wrap_dek(1, &[1; 32]).unwrap_err().code,
            "blob_key_vault_locked"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_blob_metadata_without_key_descriptor_requires_recovery() {
        let root = temporary_directory("recovery");
        let connection = Connection::open(root.join("omnia.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE blob_objects (id TEXT PRIMARY KEY);\n\
                 INSERT INTO blob_objects (id) VALUES ('existing');",
            )
            .unwrap();
        drop(connection);
        let vault = Arc::new(MemoryVault::available());
        let error =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
                .err()
                .unwrap();
        assert_eq!(error.code, "blob_key_recovery_required");
        assert!(vault.keys.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_metadata_and_cross_profile_use_are_rejected() {
        let root = temporary_directory("metadata");
        let vault = Arc::new(MemoryVault::available());
        BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
            .unwrap();
        let error = BlobKeyBroker::initialize_with_vault(&root, "other_profile", vault.clone())
            .err()
            .unwrap();
        assert_eq!(error.code, "blob_key_scope_mismatch");

        fs::write(
            root.join(METADATA_DIRECTORY).join(METADATA_FILE),
            br#"{"formatVersion":1,"unexpected":true}"#,
        )
        .unwrap();
        let error = BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault)
            .err()
            .unwrap();
        assert_eq!(error.code, "blob_key_metadata_invalid");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reopening_validates_every_historical_key_slot() {
        let root = temporary_directory("historical-slots");
        let vault = Arc::new(MemoryVault::available());
        let broker =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
                .unwrap();
        let current_ref = broker
            .metadata
            .current_slot()
            .unwrap()
            .credential_ref
            .clone();
        let new_current_ref = format!("blob_key_{}", Uuid::new_v4().simple());
        vault.write(&new_current_ref, &[0x6a; 32]).unwrap();

        let metadata_path = root.join(METADATA_DIRECTORY).join(METADATA_FILE);
        let mut metadata = broker.metadata.clone();
        metadata.current_key_version = 2;
        metadata.keys.push(BlobKeySlot {
            key_version: 2,
            credential_ref: new_current_ref,
        });
        fs::write(
            &metadata_path,
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
            .expect("all declared key slots are available");

        vault.remove(&current_ref);
        let error =
            BlobKeyBroker::initialize_with_vault(&root, DEFAULT_BLOB_PROFILE_SCOPE, vault.clone())
                .err()
                .unwrap();
        assert_eq!(error.code, "blob_key_missing");
        assert!(vault
            .read(&metadata.current_slot().unwrap().credential_ref)
            .unwrap()
            .is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
