use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use aes_gcm::{
    aead::{Aead, Nonce, Payload},
    Aes256Gcm, KeyInit,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{NativeError, NativeResult};

pub const CIPHER_VERSION_AES_256_GCM: i64 = 1;
pub const DEFAULT_MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: u64 = 16;
const MAX_MEDIA_TYPE_BYTES: usize = 255;
const STORE_VERSION_DIRECTORY: &str = "v1";

/// Key wrapping stays outside the content store so platform protection, key
/// rotation, and recovery policy can evolve without changing blob ciphertext.
pub trait BlobKeyProvider: Send + Sync {
    fn current_key_version(&self) -> NativeResult<i64>;
    fn wrap_dek(&self, key_version: i64, dek: &[u8; 32]) -> NativeResult<Vec<u8>>;
    fn unwrap_dek(&self, key_version: i64, wrapped_dek: &[u8])
        -> NativeResult<Zeroizing<[u8; 32]>>;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobDescriptor {
    pub id: String,
    pub cipher_version: i64,
    pub key_version: i64,
    pub wrapped_dek: Vec<u8>,
    pub nonce: Vec<u8>,
    pub media_type: String,
    pub plaintext_size: i64,
    pub ciphertext_size: i64,
    pub storage_relpath: String,
}

#[derive(Debug)]
pub struct PreparedBlob {
    descriptor: BlobDescriptor,
    temporary_path: Option<PathBuf>,
    final_path: PathBuf,
}

/// Publication deliberately distinguishes a newly written object from a
/// content-addressed deduplication hit. AES-GCM encryption is randomized, so a
/// descriptor created for the losing write can never describe the ciphertext
/// that was already present. Callers handling `AlreadyExists` must load the
/// authoritative descriptor from durable metadata instead of persisting the
/// prepared descriptor.
#[derive(Clone, Debug)]
pub enum BlobCommitOutcome {
    Published(BlobDescriptor),
    AlreadyExists { id: String, storage_relpath: String },
}

impl PreparedBlob {
    pub fn descriptor(&self) -> &BlobDescriptor {
        &self.descriptor
    }

    /// Publishes the ciphertext without replacing an existing content-addressed
    /// object. A deduplication hit never exposes the losing descriptor because
    /// its randomized nonce and wrapped DEK do not match the existing body.
    pub fn commit(mut self) -> NativeResult<BlobCommitOutcome> {
        let temporary_path = self.temporary_path.take().ok_or_else(|| {
            NativeError::new(
                "blob_state_invalid",
                "The prepared blob was already consumed",
            )
        })?;
        let published = match publish_without_overwrite(&temporary_path, &self.final_path) {
            Ok(published) => published,
            Err(error) => {
                // Keep ownership of a surviving temporary path so `Drop` can
                // make a second best-effort cleanup attempt before returning.
                self.temporary_path = Some(temporary_path);
                return Err(error);
            }
        };
        if published {
            Ok(BlobCommitOutcome::Published(self.descriptor.clone()))
        } else {
            if let Err(error) = fs::remove_file(&temporary_path) {
                self.temporary_path = Some(temporary_path);
                return Err(NativeError::io(
                    "could not remove a deduplicated temporary blob",
                    error,
                ));
            }
            validate_existing_ciphertext(
                &self.final_path,
                u64::try_from(self.descriptor.ciphertext_size).map_err(|_| {
                    NativeError::new(
                        "blob_metadata_invalid",
                        "The encrypted attachment size is invalid",
                    )
                })?,
            )?;
            Ok(BlobCommitOutcome::AlreadyExists {
                id: self.descriptor.id.clone(),
                storage_relpath: self.descriptor.storage_relpath.clone(),
            })
        }
    }
}

impl Drop for PreparedBlob {
    fn drop(&mut self) {
        if let Some(path) = self.temporary_path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

pub struct ContentStore {
    root: PathBuf,
    max_blob_bytes: u64,
}

impl ContentStore {
    pub fn open(app_data_dir: &Path) -> NativeResult<Self> {
        Self::open_with_limit(app_data_dir, DEFAULT_MAX_BLOB_BYTES)
    }

    pub fn open_with_limit(app_data_dir: &Path, max_blob_bytes: u64) -> NativeResult<Self> {
        if max_blob_bytes == 0 || max_blob_bytes > i64::MAX as u64 - AES_GCM_TAG_BYTES {
            return Err(NativeError::invalid(
                "maxBlobBytes",
                "is outside the safe range",
            ));
        }
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
        let root = app_data_dir.join("blobs");
        create_safe_directory(&root, "could not create the encrypted blob store")?;
        let root = dunce::canonicalize(root).map_err(|error| {
            NativeError::io("could not resolve the encrypted blob store", error)
        })?;
        if !root.starts_with(&app_data_dir) {
            return Err(NativeError::new(
                "blob_store_scope_violation",
                "The encrypted blob store resolved outside the Omnia profile",
            ));
        }
        reject_reparse_components(&app_data_dir, &root)?;

        let store = Self {
            root,
            max_blob_bytes,
        };
        store.ensure_safe_directory(&store.root.join(STORE_VERSION_DIRECTORY))?;
        Ok(store)
    }

    pub fn max_blob_bytes(&self) -> u64 {
        self.max_blob_bytes
    }

    pub fn prepare_bytes(
        &self,
        keys: &dyn BlobKeyProvider,
        media_type: &str,
        plaintext: &[u8],
    ) -> NativeResult<PreparedBlob> {
        let plaintext_size = u64::try_from(plaintext.len()).map_err(|_| {
            NativeError::new("blob_too_large", "The attachment is too large to store")
        })?;
        if plaintext_size > self.max_blob_bytes {
            return Err(NativeError::new(
                "blob_too_large",
                format!(
                    "The attachment exceeds the {} byte local limit",
                    self.max_blob_bytes
                ),
            ));
        }
        let media_type = validate_media_type(media_type)?;
        let id = sha256_hex(plaintext);
        let storage_relpath = relative_path_for_id(&id)?;
        let final_path = self.checked_path(&storage_relpath)?;
        let parent = final_path.parent().ok_or_else(|| {
            NativeError::new("blob_path_invalid", "The blob path has no parent directory")
        })?;
        self.ensure_safe_directory(parent)?;

        let key_version = keys.current_key_version()?;
        if key_version <= 0 {
            return Err(NativeError::new(
                "blob_key_invalid",
                "The active blob wrapping-key version is invalid",
            ));
        }
        let mut dek = Zeroizing::new([0_u8; 32]);
        getrandom::fill(dek.as_mut()).map_err(|_| {
            NativeError::new(
                "randomness_unavailable",
                "Windows secure randomness is unavailable for blob encryption",
            )
        })?;
        let mut nonce = [0_u8; AES_GCM_NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(|_| {
            NativeError::new(
                "randomness_unavailable",
                "Windows secure randomness is unavailable for blob encryption",
            )
        })?;

        let plaintext_size_i64 = i64::try_from(plaintext_size)
            .map_err(|_| NativeError::new("blob_too_large", "The attachment is too large"))?;
        let aad = associated_data(
            &id,
            CIPHER_VERSION_AES_256_GCM,
            key_version,
            &media_type,
            plaintext_size_i64,
        );
        let cipher = Aes256Gcm::new_from_slice(dek.as_ref()).map_err(|_| {
            NativeError::new(
                "blob_encryption_failed",
                "Could not initialize blob encryption",
            )
        })?;
        let nonce = Nonce::<Aes256Gcm>::from(nonce);
        let mut ciphertext = Zeroizing::new(
            cipher
                .encrypt(
                    &nonce,
                    Payload {
                        msg: plaintext,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| {
                    NativeError::new("blob_encryption_failed", "Could not encrypt the blob")
                })?,
        );
        let wrapped_dek = keys.wrap_dek(key_version, &dek)?;
        if wrapped_dek.is_empty() {
            return Err(NativeError::new(
                "blob_key_wrap_failed",
                "The blob key broker returned an empty wrapped key",
            ));
        }

        let temporary_path = self.create_temporary(parent, &id, ciphertext.as_slice())?;
        let ciphertext_size = i64::try_from(ciphertext.len()).map_err(|_| {
            NativeError::new("blob_too_large", "The encrypted attachment is too large")
        })?;
        ciphertext.zeroize();

        Ok(PreparedBlob {
            descriptor: BlobDescriptor {
                id,
                cipher_version: CIPHER_VERSION_AES_256_GCM,
                key_version,
                wrapped_dek,
                nonce: nonce.to_vec(),
                media_type,
                plaintext_size: plaintext_size_i64,
                ciphertext_size,
                storage_relpath,
            },
            temporary_path: Some(temporary_path),
            final_path,
        })
    }

    pub fn read_verified(
        &self,
        keys: &dyn BlobKeyProvider,
        descriptor: &BlobDescriptor,
        max_bytes: u64,
    ) -> NativeResult<Zeroizing<Vec<u8>>> {
        validate_descriptor(descriptor, self.max_blob_bytes, max_bytes)?;
        let expected_relpath = relative_path_for_id(&descriptor.id)?;
        if descriptor.storage_relpath != expected_relpath {
            return Err(NativeError::new(
                "blob_metadata_invalid",
                "The blob storage path does not match its content hash",
            ));
        }
        let path = self.checked_path(&descriptor.storage_relpath)?;
        let parent = path.parent().ok_or_else(|| {
            NativeError::new("blob_path_invalid", "The blob path has no parent directory")
        })?;
        self.validate_existing_parent(parent)?;

        let file =
            open_read_without_following_final_reparse_point(&path).map_err(|error| match error
                .kind()
            {
                std::io::ErrorKind::NotFound => NativeError::new(
                    "blob_missing",
                    "The attachment body is missing from local storage",
                ),
                _ => NativeError::io("could not open the encrypted blob", error),
            })?;
        let metadata = file
            .metadata()
            .map_err(|error| NativeError::io("could not inspect the encrypted blob", error))?;
        if !metadata.is_file() || is_reparse_point(&metadata) {
            return Err(NativeError::new(
                "blob_path_unsafe",
                "The blob body is not a regular local file",
            ));
        }
        if metadata.len() != descriptor.ciphertext_size as u64 {
            return Err(NativeError::new(
                "blob_integrity_failed",
                "The encrypted blob size does not match its metadata",
            ));
        }
        let mut ciphertext = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
        file.take(metadata.len() + 1)
            .read_to_end(&mut ciphertext)
            .map_err(|error| NativeError::io("could not read the encrypted blob", error))?;
        if ciphertext.len() as u64 != metadata.len() {
            return Err(NativeError::new(
                "blob_integrity_failed",
                "The encrypted blob changed while it was being read",
            ));
        }

        let dek = keys.unwrap_dek(descriptor.key_version, &descriptor.wrapped_dek)?;
        let cipher = Aes256Gcm::new_from_slice(dek.as_ref()).map_err(|_| {
            NativeError::new(
                "blob_decryption_failed",
                "Could not initialize blob decryption",
            )
        })?;
        let aad = associated_data(
            &descriptor.id,
            descriptor.cipher_version,
            descriptor.key_version,
            &descriptor.media_type,
            descriptor.plaintext_size,
        );
        let nonce = Nonce::<Aes256Gcm>::try_from(descriptor.nonce.as_slice()).map_err(|_| {
            NativeError::new(
                "blob_metadata_invalid",
                "The attachment nonce has an invalid length",
            )
        })?;
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &nonce,
                    Payload {
                        msg: ciphertext.as_slice(),
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| {
                    NativeError::new(
                        "blob_integrity_failed",
                        "The attachment body or its metadata failed authentication",
                    )
                })?,
        );
        if plaintext.len() as i64 != descriptor.plaintext_size
            || sha256_hex(plaintext.as_slice()) != descriptor.id
        {
            return Err(NativeError::new(
                "blob_integrity_failed",
                "The decrypted attachment does not match its content hash",
            ));
        }
        Ok(plaintext)
    }

    pub fn delete_file_if_present(&self, storage_relpath: &str) -> NativeResult<bool> {
        let id = id_from_relative_path(storage_relpath)?;
        let expected = relative_path_for_id(&id)?;
        if storage_relpath != expected {
            return Err(NativeError::new(
                "blob_path_invalid",
                "The blob path is not canonical",
            ));
        }
        let path = self.checked_path(storage_relpath)?;
        if let Some(parent) = path.parent() {
            self.validate_existing_parent(parent)?;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => {}
            Ok(_) => {
                return Err(NativeError::new(
                    "blob_path_unsafe",
                    "The blob body is not a regular local file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(NativeError::io(
                    "could not inspect the encrypted blob before deletion",
                    error,
                ));
            }
        }
        match fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(NativeError::io(
                "could not remove the encrypted blob",
                error,
            )),
        }
    }

    fn create_temporary(
        &self,
        parent: &Path,
        id: &str,
        ciphertext: &[u8],
    ) -> NativeResult<PathBuf> {
        for _ in 0..8 {
            let path = parent.join(format!(".{id}.{}.tmp", Uuid::new_v4().simple()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let result = (|| {
                        file.write_all(ciphertext).map_err(|error| {
                            NativeError::io("could not write the encrypted blob", error)
                        })?;
                        file.sync_all().map_err(|error| {
                            NativeError::io("could not flush the encrypted blob", error)
                        })?;
                        Ok(())
                    })();
                    drop(file);
                    if let Err(error) = result {
                        let _ = fs::remove_file(&path);
                        return Err(error);
                    }
                    return Ok(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(NativeError::io(
                        "could not create a temporary encrypted blob",
                        error,
                    ));
                }
            }
        }
        Err(NativeError::retryable(
            "blob_write_conflict",
            "Could not allocate a unique temporary blob file",
        ))
    }

    fn checked_path(&self, storage_relpath: &str) -> NativeResult<PathBuf> {
        let relative = Path::new(storage_relpath);
        if relative.is_absolute()
            || relative.components().any(|component| {
                !matches!(component, Component::Normal(_))
                    || component
                        .as_os_str()
                        .to_str()
                        .map_or(true, |part| part.is_empty())
            })
        {
            return Err(NativeError::new(
                "blob_path_invalid",
                "The blob path is not a safe relative path",
            ));
        }
        let candidate = self.root.join(relative);
        if !candidate.starts_with(&self.root) {
            return Err(NativeError::new(
                "blob_store_scope_violation",
                "The blob path escapes the Omnia content store",
            ));
        }
        Ok(candidate)
    }

    fn validate_existing_parent(&self, parent: &Path) -> NativeResult<()> {
        // Inspect the lexical path before canonicalization. Canonicalizing
        // first would erase evidence that an in-root junction redirected one
        // of the original path components.
        reject_reparse_components(&self.root, parent)?;
        let parent = dunce::canonicalize(parent)
            .map_err(|error| NativeError::io("could not resolve the blob directory", error))?;
        if !parent.starts_with(&self.root) {
            return Err(NativeError::new(
                "blob_store_scope_violation",
                "The blob directory resolves outside the Omnia content store",
            ));
        }
        reject_reparse_components(&self.root, &parent)
    }

    fn ensure_safe_directory(&self, directory: &Path) -> NativeResult<()> {
        let relative = directory.strip_prefix(&self.root).map_err(|_| {
            NativeError::new(
                "blob_store_scope_violation",
                "The blob directory is outside the content-store root",
            )
        })?;
        let mut current = self.root.clone();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                return Err(NativeError::new(
                    "blob_path_invalid",
                    "The blob directory is not a safe relative path",
                ));
            };
            current.push(part);
            create_safe_directory(&current, "could not create the blob shard directory")?;
        }
        self.validate_existing_parent(directory)
    }
}

fn validate_descriptor(
    descriptor: &BlobDescriptor,
    store_limit: u64,
    requested_limit: u64,
) -> NativeResult<()> {
    validate_blob_id(&descriptor.id)?;
    if validate_media_type(&descriptor.media_type)? != descriptor.media_type {
        return Err(NativeError::new(
            "blob_metadata_invalid",
            "The attachment media type is not canonical",
        ));
    }
    if descriptor.cipher_version != CIPHER_VERSION_AES_256_GCM {
        return Err(NativeError::new(
            "blob_cipher_unsupported",
            "The attachment uses an unsupported cipher version",
        ));
    }
    if descriptor.key_version <= 0 || descriptor.wrapped_dek.is_empty() {
        return Err(NativeError::new(
            "blob_metadata_invalid",
            "The attachment key metadata is incomplete",
        ));
    }
    if descriptor.nonce.len() != AES_GCM_NONCE_BYTES {
        return Err(NativeError::new(
            "blob_metadata_invalid",
            "The attachment nonce has an invalid length",
        ));
    }
    if descriptor.plaintext_size < 0 || descriptor.ciphertext_size < 0 {
        return Err(NativeError::new(
            "blob_metadata_invalid",
            "The attachment size metadata is invalid",
        ));
    }
    let plaintext_size = descriptor.plaintext_size as u64;
    let effective_limit = store_limit.min(requested_limit);
    if plaintext_size > effective_limit {
        return Err(NativeError::new(
            "blob_too_large",
            format!("The attachment exceeds the {effective_limit} byte read limit"),
        ));
    }
    if descriptor.ciphertext_size as u64 != plaintext_size + AES_GCM_TAG_BYTES {
        return Err(NativeError::new(
            "blob_metadata_invalid",
            "The encrypted attachment size is inconsistent with AES-GCM framing",
        ));
    }
    Ok(())
}

fn validate_media_type(media_type: &str) -> NativeResult<String> {
    let normalized = media_type.trim().to_ascii_lowercase();
    let valid = !normalized.is_empty()
        && normalized.len() <= MAX_MEDIA_TYPE_BYTES
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'-' | b'.'))
        && normalized
            .split_once('/')
            .is_some_and(|(kind, subtype)| !kind.is_empty() && !subtype.is_empty());
    if valid {
        Ok(normalized)
    } else {
        Err(NativeError::invalid(
            "mediaType",
            "must be a bounded MIME type without parameters",
        ))
    }
}

fn validate_blob_id(id: &str) -> NativeResult<()> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(NativeError::invalid(
            "blobId",
            "must be a lowercase SHA-256 digest",
        ))
    }
}

fn relative_path_for_id(id: &str) -> NativeResult<String> {
    validate_blob_id(id)?;
    Ok(format!(
        "{STORE_VERSION_DIRECTORY}/{}/{}",
        &id[..2],
        &id[2..]
    ))
}

fn id_from_relative_path(storage_relpath: &str) -> NativeResult<String> {
    let parts: Vec<&str> = storage_relpath.split('/').collect();
    if parts.len() != 3
        || parts[0] != STORE_VERSION_DIRECTORY
        || parts[1].len() != 2
        || parts[2].len() != 62
    {
        return Err(NativeError::new(
            "blob_path_invalid",
            "The blob path is not a canonical content-addressed path",
        ));
    }
    let id = format!("{}{}", parts[1], parts[2]);
    validate_blob_id(&id)?;
    Ok(id)
}

fn associated_data(
    id: &str,
    cipher_version: i64,
    key_version: i64,
    media_type: &str,
    plaintext_size: i64,
) -> String {
    format!("omnia-blob\0{id}\0{cipher_version}\0{key_version}\0{media_type}\0{plaintext_size}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn publish_without_overwrite(temporary_path: &Path, final_path: &Path) -> NativeResult<bool> {
    match fs::hard_link(temporary_path, final_path) {
        Ok(()) => {
            // Publication is the commit point. Do not turn a temporary-link
            // cleanup problem into an ambiguous failed commit after the final
            // content-addressed object already exists.
            let _ = fs::remove_file(temporary_path);
            sync_parent_directory(final_path);
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(NativeError::io(
            "could not atomically publish the encrypted blob",
            error,
        )),
    }
}

fn create_safe_directory(path: &Path, context: &'static str) -> NativeResult<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(NativeError::io(context, error)),
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeError::io("could not inspect the blob directory", error))?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(NativeError::new(
            "blob_path_unsafe",
            "The blob directory is not a regular local directory",
        ));
    }
    Ok(())
}

fn validate_existing_ciphertext(path: &Path, expected_size: u64) -> NativeResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| NativeError::io("could not inspect an existing encrypted blob", error))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(NativeError::new(
            "blob_path_unsafe",
            "The existing blob body is not a regular local file",
        ));
    }
    if metadata.len() != expected_size {
        return Err(NativeError::new(
            "blob_integrity_failed",
            "The existing encrypted blob size is inconsistent with its content address",
        ));
    }
    Ok(())
}

fn open_read_without_following_final_reparse_point(path: &Path) -> std::io::Result<File> {
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

fn sync_parent_directory(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

fn reject_reparse_components(root: &Path, target: &Path) -> NativeResult<()> {
    let relative = target.strip_prefix(root).map_err(|_| {
        NativeError::new(
            "blob_store_scope_violation",
            "The blob directory is outside the content-store root",
        )
    })?;
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| NativeError::io("could not inspect the blob-store root", error))?;
    if !root_metadata.is_dir() || is_reparse_point(&root_metadata) {
        return Err(NativeError::new(
            "blob_path_unsafe",
            "The blob-store root is not a regular local directory",
        ));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| NativeError::io("could not inspect the blob path", error))?;
        if is_reparse_point(&metadata) {
            return Err(NativeError::new(
                "blob_path_unsafe",
                "The blob path contains a symbolic link or reparse point",
            ));
        }
    }
    Ok(())
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
    use std::sync::Mutex;

    use super::*;

    struct TestKeyProvider {
        key: [u8; 32],
        unwrap_calls: Mutex<usize>,
    }

    impl Default for TestKeyProvider {
        fn default() -> Self {
            Self {
                key: [0x5a; 32],
                unwrap_calls: Mutex::new(0),
            }
        }
    }

    impl BlobKeyProvider for TestKeyProvider {
        fn current_key_version(&self) -> NativeResult<i64> {
            Ok(7)
        }

        fn wrap_dek(&self, key_version: i64, dek: &[u8; 32]) -> NativeResult<Vec<u8>> {
            assert_eq!(key_version, 7);
            Ok(dek
                .iter()
                .zip(self.key)
                .map(|(left, right)| left ^ right)
                .collect())
        }

        fn unwrap_dek(
            &self,
            key_version: i64,
            wrapped_dek: &[u8],
        ) -> NativeResult<Zeroizing<[u8; 32]>> {
            assert_eq!(key_version, 7);
            *self.unwrap_calls.lock().unwrap() += 1;
            let wrapped: [u8; 32] = wrapped_dek.try_into().map_err(|_| {
                NativeError::new("blob_key_invalid", "The wrapped test key is malformed")
            })?;
            let mut dek = [0_u8; 32];
            for (index, byte) in wrapped.iter().enumerate() {
                dek[index] = byte ^ self.key[index];
            }
            Ok(Zeroizing::new(dek))
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "omnia-content-store-{label}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn encrypted_round_trip_is_content_addressed_and_hides_plaintext() {
        let root = temporary_directory("roundtrip");
        let store = ContentStore::open_with_limit(&root, 1_024).unwrap();
        let keys = TestKeyProvider::default();
        let plaintext = b"private attachment body";

        let prepared = store.prepare_bytes(&keys, "Text/Plain", plaintext).unwrap();
        let descriptor = prepared.descriptor().clone();
        assert_eq!(descriptor.id, sha256_hex(plaintext));
        assert_eq!(descriptor.media_type, "text/plain");
        assert_eq!(
            descriptor.storage_relpath,
            relative_path_for_id(&descriptor.id).unwrap()
        );
        assert_eq!(descriptor.ciphertext_size, plaintext.len() as i64 + 16);
        let descriptor = match prepared.commit().unwrap() {
            BlobCommitOutcome::Published(descriptor) => descriptor,
            BlobCommitOutcome::AlreadyExists { .. } => panic!("first write must publish"),
        };

        let ciphertext =
            fs::read(store.checked_path(&descriptor.storage_relpath).unwrap()).unwrap();
        assert!(!ciphertext
            .windows(plaintext.len())
            .any(|window| window == plaintext));
        assert_eq!(
            store
                .read_verified(&keys, &descriptor, 1_024)
                .unwrap()
                .as_slice(),
            plaintext
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tampering_with_ciphertext_or_authenticated_metadata_fails_closed() {
        let root = temporary_directory("tamper");
        let store = ContentStore::open_with_limit(&root, 1_024).unwrap();
        let keys = TestKeyProvider::default();
        let prepared = store
            .prepare_bytes(&keys, "application/pdf", b"fake pdf body")
            .unwrap();
        let descriptor = match prepared.commit().unwrap() {
            BlobCommitOutcome::Published(descriptor) => descriptor,
            BlobCommitOutcome::AlreadyExists { .. } => panic!("first write must publish"),
        };
        let path = store.checked_path(&descriptor.storage_relpath).unwrap();
        let original = fs::read(&path).unwrap();

        let mut tampered = original.clone();
        tampered[0] ^= 0x80;
        fs::write(&path, tampered).unwrap();
        assert_eq!(
            store
                .read_verified(&keys, &descriptor, 1_024)
                .unwrap_err()
                .code,
            "blob_integrity_failed"
        );

        fs::write(&path, original).unwrap();
        let mut metadata_tampered = descriptor.clone();
        metadata_tampered.media_type = "text/plain".into();
        assert_eq!(
            store
                .read_verified(&keys, &metadata_tampered, 1_024)
                .unwrap_err()
                .code,
            "blob_integrity_failed"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn size_limits_and_paths_are_validated_before_allocation_or_io() {
        let root = temporary_directory("limits");
        let store = ContentStore::open_with_limit(&root, 8).unwrap();
        let keys = TestKeyProvider::default();
        assert_eq!(
            store
                .prepare_bytes(&keys, "text/plain", b"123456789")
                .unwrap_err()
                .code,
            "blob_too_large"
        );
        assert!(store.checked_path("../escape").is_err());
        assert!(relative_path_for_id(&"A".repeat(64)).is_err());
        assert!(validate_media_type("text/plain; charset=utf-8").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepare_drop_removes_temporary_ciphertext_and_dedupe_never_overwrites() {
        let root = temporary_directory("atomic");
        let store = ContentStore::open_with_limit(&root, 1_024).unwrap();
        let keys = TestKeyProvider::default();
        let first = store
            .prepare_bytes(&keys, "text/plain", b"same bytes")
            .unwrap();
        let descriptor = match first.commit().unwrap() {
            BlobCommitOutcome::Published(descriptor) => descriptor,
            BlobCommitOutcome::AlreadyExists { .. } => panic!("first write must publish"),
        };
        let first_ciphertext =
            fs::read(store.checked_path(&descriptor.storage_relpath).unwrap()).unwrap();

        let second = store
            .prepare_bytes(&keys, "text/plain", b"same bytes")
            .unwrap();
        let losing_descriptor = second.descriptor().clone();
        assert_ne!(losing_descriptor.nonce, descriptor.nonce);
        match second.commit().unwrap() {
            BlobCommitOutcome::Published(_) => {
                panic!("duplicate write must not replace ciphertext")
            }
            BlobCommitOutcome::AlreadyExists {
                id,
                storage_relpath,
            } => {
                assert_eq!(id, descriptor.id);
                assert_eq!(storage_relpath, descriptor.storage_relpath);
            }
        }
        assert_eq!(
            fs::read(store.checked_path(&descriptor.storage_relpath).unwrap()).unwrap(),
            first_ciphertext
        );
        assert_eq!(
            store
                .read_verified(&keys, &descriptor, 1_024)
                .unwrap()
                .as_slice(),
            b"same bytes"
        );
        assert_eq!(
            store
                .read_verified(&keys, &losing_descriptor, 1_024)
                .unwrap_err()
                .code,
            "blob_integrity_failed"
        );

        let abandoned = store
            .prepare_bytes(&keys, "text/plain", b"abandoned")
            .unwrap();
        let temporary_path = abandoned.temporary_path.as_ref().unwrap().clone();
        assert!(temporary_path.exists());
        drop(abandoned);
        assert!(!temporary_path.exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_limit_is_enforced_before_key_unwrap() {
        let root = temporary_directory("read-limit");
        let store = ContentStore::open_with_limit(&root, 1_024).unwrap();
        let keys = TestKeyProvider::default();
        let prepared = store
            .prepare_bytes(&keys, "text/plain", b"bounded content")
            .unwrap();
        let descriptor = match prepared.commit().unwrap() {
            BlobCommitOutcome::Published(descriptor) => descriptor,
            BlobCommitOutcome::AlreadyExists { .. } => panic!("first write must publish"),
        };

        assert_eq!(
            store.read_verified(&keys, &descriptor, 4).unwrap_err().code,
            "blob_too_large"
        );
        assert_eq!(*keys.unwrap_calls.lock().unwrap(), 0);

        fs::remove_dir_all(root).unwrap();
    }
}
