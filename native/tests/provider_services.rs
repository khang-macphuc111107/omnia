//! Pure consumer checks. No real credential is read, written or deleted.
use omnia_provider_services::{SecretBroker, SecretPurpose};

#[test]
fn malformed_reference_is_rejected_before_secret_callback() {
    let broker = SecretBroker;
    let mut called = false;
    let result = broker.with_secret(SecretPurpose::ProviderCredential, "raw-api-key", |_| {
        called = true;
        Ok(())
    });
    assert!(!called);
    let error = result.expect_err("malformed references must not reach the vault");
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn invalid_secret_is_rejected_before_creating_credential() {
    let broker = SecretBroker;
    assert!(broker
        .put(SecretPurpose::ProviderCredential, "  ".into())
        .is_err());
    assert!(broker
        .put(SecretPurpose::ProviderCredential, "x".repeat(16 * 1024 + 1))
        .is_err());
}
