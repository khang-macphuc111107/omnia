//! Windows Credential Manager (`CredReadW`/`CredWriteW`/`CredDeleteW`/`CredEnumerateW`)
//! with compile-time non-serializable [`RedactedSecret`] handles and masked public metadata.

use crate::utf16::{utf16_nul_to_utf8, utf8_to_utf16_nul};
use crate::CoreError;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// Target namespace prefix enforced when enumerating Omnia-managed credentials.
pub const OMNIA_CREDENTIAL_PREFIX: &str = "omnia:";

/// Non-serializable secret handle whose `Debug` output is always `[REDACTED]`
/// and whose internal memory is scrubbed on [`Drop`].
pub struct RedactedSecret {
    bytes: Vec<u8>,
}

impl RedactedSecret {
    /// Wraps raw secret bytes in a zeroized-on-drop container.
    #[must_use]
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Exposes the underlying UTF-8 secret ONLY for authorized outbound wire/auth calls.
    /// Never pass this slice to logs, traces, errors, or JSON responses.
    pub fn expose_for_wire(&self) -> Result<&str, CoreError> {
        std::str::from_utf8(&self.bytes)
            .map_err(|e| CoreError::CredentialError(format!("credential payload not UTF-8: {e}")))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl fmt::Debug for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedSecret([REDACTED])")
    }
}

impl Drop for RedactedSecret {
    fn drop(&mut self) {
        for slot in &mut self.bytes {
            // SAFETY: `slot` points inside valid, exclusively owned `Vec<u8>` allocation.
            #[allow(unsafe_code)]
            unsafe {
                std::ptr::write_volatile(slot, 0);
            }
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
        self.bytes.clear();
    }
}

/// Public masked metadata safe for UI/Studio display and audit logs (never carries raw secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaskedCredential {
    pub target: String,
    pub kind: String,
    pub label: String,
    pub masked_hint: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CredentialCommentMeta {
    kind: String,
    label: String,
    updated_at_ms: u64,
}

/// Computes a safe masked preview without exposing short or sensitive prefixes.
#[must_use]
pub fn mask_secret_hint(secret: &str) -> String {
    let trimmed = secret.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 12 {
        return "***".to_owned();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().rev().take(4).rev().collect();
    format!("{head}...{tail}")
}

/// Normalizes a logical credential target under the `omnia:` namespace unless already scoped.
pub fn normalize_credential_target(raw_target: &str) -> Result<String, CoreError> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput("credential target must not be empty".into()));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "credential target must not contain control characters".into(),
        ));
    }
    if trimmed.starts_with(OMNIA_CREDENTIAL_PREFIX) {
        Ok(trimmed.to_owned())
    } else {
        Ok(format!("{OMNIA_CREDENTIAL_PREFIX}{trimmed}"))
    }
}

/// Native Windows Credential Manager store (fail-closed on invalid inputs or OS errors).
#[derive(Debug, Default, Clone, Copy)]
pub struct CredentialStore;

impl CredentialStore {
    /// Stores or updates a generic credential in Windows Credential Manager and returns its masked view.
    pub fn set_secret(
        target: &str,
        kind: &str,
        label: &str,
        secret: &str,
    ) -> Result<MaskedCredential, CoreError> {
        let norm_target = normalize_credential_target(target)?;
        if secret.is_empty() {
            return Err(CoreError::InvalidInput("credential secret must not be empty".into()));
        }
        let kind_clean = if kind.trim().is_empty() {
            "api_key".to_owned()
        } else {
            kind.trim().to_owned()
        };
        let label_clean = if label.trim().is_empty() {
            norm_target.clone()
        } else {
            label.trim().to_owned()
        };
        let updated_at_ms = now_epoch_ms();
        let meta = CredentialCommentMeta {
            kind: kind_clean.clone(),
            label: label_clean.clone(),
            updated_at_ms,
        };
        let comment_json = serde_json::to_string(&meta)
            .map_err(|e| CoreError::CredentialError(format!("serialize credential meta: {e}")))?;

        write_os_credential(&norm_target, &comment_json, secret.as_bytes())?;

        Ok(MaskedCredential {
            target: norm_target,
            kind: kind_clean,
            label: label_clean,
            masked_hint: mask_secret_hint(secret),
            updated_at_ms,
        })
    }

    /// Reads one secret from Windows Credential Manager wrapped in [`RedactedSecret`].
    pub fn resolve_secret(target: &str) -> Result<Option<RedactedSecret>, CoreError> {
        let norm_target = normalize_credential_target(target)?;
        read_os_credential(&norm_target)
    }

    /// Lists all `omnia:*` credentials with masked hints only (zero plaintext secrets).
    pub fn list_masked() -> Result<Vec<MaskedCredential>, CoreError> {
        enumerate_os_credentials(OMNIA_CREDENTIAL_PREFIX)
    }

    /// Deletes a stored credential by target; returns `Ok(true)` if removed or `Ok(false)` if absent.
    pub fn delete_secret(target: &str) -> Result<bool, CoreError> {
        let norm_target = normalize_credential_target(target)?;
        delete_os_credential(&norm_target)
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn parse_comment_meta(target: &str, comment: Option<&str>) -> CredentialCommentMeta {
    if let Some(raw) = comment.map(str::trim).filter(|s| s.starts_with('{')) {
        if let Ok(parsed) = serde_json::from_str::<CredentialCommentMeta>(raw) {
            return parsed;
        }
    }
    CredentialCommentMeta {
        kind: "custom".into(),
        label: target.to_owned(),
        updated_at_ms: 0,
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn write_os_credential(target: &str, comment_json: &str, blob: &[u8]) -> Result<(), CoreError> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let blob_len = u32::try_from(blob.len())
        .map_err(|_| CoreError::InvalidInput("credential secret exceeds Win32 limit".into()))?;
    let mut target_w = utf8_to_utf16_nul(target);
    let mut comment_w = utf8_to_utf16_nul(comment_json);
    let mut user_w = utf8_to_utf16_nul("omnia");
    let mut blob_copy = blob.to_vec();

    let cred = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_mut_ptr(),
        Comment: comment_w.as_mut_ptr(),
        LastWritten: unsafe { std::mem::zeroed() },
        CredentialBlobSize: blob_len,
        CredentialBlob: blob_copy.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: user_w.as_mut_ptr(),
    };

    let ok = unsafe { CredWriteW(&cred, 0) };
    // Zeroize temporary blob copy immediately after CredWriteW returns.
    for b in &mut blob_copy {
        unsafe {
            std::ptr::write_volatile(b, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);

    if ok == 0 {
        return Err(CoreError::CredentialError(format!(
            "CredWriteW failed for `{target}`: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn read_os_credential(target: &str) -> Result<Option<RedactedSecret>, CoreError> {
    use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target_w = utf8_to_utf16_nul(target);
    let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            return Ok(None);
        }
        return Err(CoreError::CredentialError(format!(
            "CredReadW failed for `{target}`: {err}"
        )));
    }
    if cred_ptr.is_null() {
        return Ok(None);
    }

    let result = unsafe {
        let cred = &*cred_ptr;
        let bytes = if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                .to_vec()
        };
        RedactedSecret::from_bytes(bytes)
    };
    unsafe {
        CredFree(cred_ptr.cast());
    }
    Ok(Some(result))
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn enumerate_os_credentials(prefix: &str) -> Result<Vec<MaskedCredential>, CoreError> {
    use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
    use windows_sys::Win32::Security::Credentials::{
        CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let filter = format!("{prefix}*");
    let filter_w = utf8_to_utf16_nul(&filter);
    let mut count: u32 = 0;
    let mut creds_ptr: *mut *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredEnumerateW(filter_w.as_ptr(), 0, &mut count, &mut creds_ptr) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            return Ok(Vec::new());
        }
        return Err(CoreError::CredentialError(format!(
            "CredEnumerateW failed: {err}"
        )));
    }
    if creds_ptr.is_null() || count == 0 {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(count as usize);
    unsafe {
        let slice = std::slice::from_raw_parts(creds_ptr, count as usize);
        for &ptr in slice {
            if ptr.is_null() {
                continue;
            }
            let cred = &*ptr;
            if cred.Type != CRED_TYPE_GENERIC || cred.TargetName.is_null() {
                continue;
            }
            let target = read_pwstr_lossy(cred.TargetName);
            let comment = if cred.Comment.is_null() {
                None
            } else {
                Some(read_pwstr_lossy(cred.Comment))
            };
            let meta = parse_comment_meta(&target, comment.as_deref());
            let mut secret_bytes = if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0
            {
                Vec::new()
            } else {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
                    .to_vec()
            };
            let masked_hint = match std::str::from_utf8(&secret_bytes) {
                Ok(s) => mask_secret_hint(s),
                Err(_) => "***".to_owned(),
            };
            for b in &mut secret_bytes {
                std::ptr::write_volatile(b, 0);
            }
            std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
            out.push(MaskedCredential {
                target,
                kind: meta.kind,
                label: meta.label,
                masked_hint,
                updated_at_ms: meta.updated_at_ms,
            });
        }
        CredFree(creds_ptr.cast());
    }
    out.sort_by(|a, b| a.target.cmp(&b.target));
    Ok(out)
}

#[cfg(windows)]
#[allow(unsafe_code)]
unsafe fn read_pwstr_lossy(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while len < 8192 && *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    utf16_nul_to_utf8(slice).unwrap_or_else(|_| String::from_utf16_lossy(slice))
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn delete_os_credential(target: &str) -> Result<bool, CoreError> {
    use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target_w = utf8_to_utf16_nul(target);
    let ok = unsafe { CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            return Ok(false);
        }
        return Err(CoreError::CredentialError(format!(
            "CredDeleteW failed for `{target}`: {err}"
        )));
    }
    Ok(true)
}

#[cfg(not(windows))]
fn write_os_credential(_target: &str, _comment: &str, _blob: &[u8]) -> Result<(), CoreError> {
    Err(CoreError::CredentialError(
        "Windows Credential Manager is only available on Windows hosts".into(),
    ))
}

#[cfg(not(windows))]
fn read_os_credential(_target: &str) -> Result<Option<RedactedSecret>, CoreError> {
    Ok(None)
}

#[cfg(not(windows))]
fn enumerate_os_credentials(_prefix: &str) -> Result<Vec<MaskedCredential>, CoreError> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
fn delete_os_credential(_target: &str) -> Result<bool, CoreError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CleanupCred(String);
    impl Drop for CleanupCred {
        fn drop(&mut self) {
            let _ = CredentialStore::delete_secret(&self.0);
        }
    }

    #[test]
    fn masks_short_and_long_hints_without_exposing_secrets() {
        assert_eq!(mask_secret_hint("short"), "***");
        assert_eq!(mask_secret_hint("123456789012"), "***");
        assert_eq!(
            mask_secret_hint("sk-dummy-credential-9876"),
            "sk-d...9876"
        );
        let sec = RedactedSecret::from_bytes(b"sk-dummy-secret-value".to_vec());
        assert_eq!(format!("{sec:?}"), "RedactedSecret([REDACTED])");
    }

    #[cfg(windows)]
    #[test]
    fn windows_credman_roundtrip_and_masked_list() {
        let target = format!("omnia:test:credman:{}", crate::uuid_v4_simple());
        let _guard = CleanupCred(target.clone());

        let masked = CredentialStore::set_secret(
            &target,
            "api_key",
            "Dummy Test Key",
            "sk-dummy-credman-roundtrip-9911",
        )
        .expect("CredWriteW");
        assert_eq!(masked.target, target);
        assert_eq!(masked.masked_hint, "sk-d...9911");

        let resolved = CredentialStore::resolve_secret(&target)
            .expect("CredReadW")
            .expect("stored cred");
        assert_eq!(
            resolved.expose_for_wire().expect("utf8"),
            "sk-dummy-credman-roundtrip-9911"
        );

        let all = CredentialStore::list_masked().expect("CredEnumerateW");
        let found = all
            .iter()
            .find(|c| c.target == target)
            .expect("listed masked cred");
        assert_eq!(found.masked_hint, "sk-d...9911");
        assert_eq!(found.kind, "api_key");

        assert!(CredentialStore::delete_secret(&target).expect("CredDeleteW"));
        assert!(CredentialStore::resolve_secret(&target)
            .expect("post-delete read")
            .is_none());
    }
}
