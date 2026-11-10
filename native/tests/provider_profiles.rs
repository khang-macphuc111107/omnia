//! Shared repository consumer over a disposable database, never the live store.
use omnia_provider_services::profiles::{CredentialStatus, ProviderProfileRepository};
use rusqlite::{Connection, OpenFlags};

const PROVIDER: &str = "provider_0123456789abcdef0123456789abcdef";

fn seed(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE TABLE provider_profiles (
                id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider_type TEXT NOT NULL,
                display_name TEXT NOT NULL, normalized_base_url TEXT NOT NULL,
                auth_scheme TEXT NOT NULL, organization_id TEXT, remote_project_id TEXT,
                credential_ref TEXT, egress_policy_json TEXT NOT NULL, enabled INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER
            );",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO provider_profiles VALUES
         (?1, 'profile_default', 'openai', 'native fixture', 'https://example.invalid',
          'bearer', NULL, NULL, 'opaque-fixture-reference', '{}', 1, 1, 2, NULL)",
            [PROVIDER],
        )
        .unwrap();
}

#[test]
fn native_repository_reads_read_only_connection_without_recovery_or_writes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("profiles.sqlite3");
    {
        let connection = Connection::open(&path).unwrap();
        seed(&connection);
    }
    let before = std::fs::read(&path).unwrap();
    {
        let connection =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let repository = ProviderProfileRepository::new(&connection, "profile_default");
        let listed = repository.list().unwrap();
        assert_eq!(listed.len(), 1);
        let snapshot = repository.credential_snapshot(PROVIDER).unwrap();
        assert_eq!(snapshot.profile.id, PROVIDER);
        assert_eq!(
            snapshot.profile.credential_status,
            CredentialStatus::Present
        );
        assert_eq!(
            snapshot.credential_ref.as_deref(),
            Some("opaque-fixture-reference")
        );
        assert!(connection
            .execute("DELETE FROM provider_profiles", [])
            .is_err());
        let json = serde_json::to_string(&snapshot.profile).unwrap();
        assert!(!json.contains("opaque-fixture-reference"));
        assert!(!json.contains("credentialRef"));
        assert!(connection.is_autocommit());
    }
    assert_eq!(before, std::fs::read(&path).unwrap());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn native_repository_observes_callers_transaction_and_app_profile_scope() {
    let mut connection = Connection::open_in_memory().unwrap();
    seed(&connection);
    {
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "UPDATE provider_profiles SET normalized_base_url = 'https://changed.invalid',
             credential_ref = NULL WHERE id = ?1",
                [PROVIDER],
            )
            .unwrap();
        let repository = ProviderProfileRepository::new(&transaction, "profile_default");
        let snapshot = repository.credential_snapshot(PROVIDER).unwrap();
        assert_eq!(
            snapshot.profile.normalized_base_url,
            "https://changed.invalid"
        );
        assert!(snapshot.credential_ref.is_none());
        assert_eq!(
            snapshot.profile.credential_status,
            CredentialStatus::Missing
        );
        transaction.rollback().unwrap();
    }
    let repository = ProviderProfileRepository::new(&connection, "profile_default");
    assert_eq!(
        repository.get(PROVIDER).unwrap().normalized_base_url,
        "https://example.invalid"
    );
    let other = ProviderProfileRepository::new(&connection, "profile_other");
    assert!(other.list().unwrap().is_empty());
    assert_eq!(
        other.active(PROVIDER).unwrap_err().code,
        "provider_profile_missing"
    );
    assert_eq!(
        other.credential_snapshot(PROVIDER).err().unwrap().code,
        "provider_profile_missing"
    );
    assert_eq!(
        other.credential_ref(PROVIDER).unwrap_err().code,
        "provider_profile_missing"
    );
}
