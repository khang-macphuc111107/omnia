//! Read-only provider metadata queries over a connection borrowed from its owner.
//!
//! This module does not open, migrate, recover, lock, or write a database. The
//! caller retains connection/transaction ownership, authority checks, and ID
//! validation. An explicit app-profile scope is a query filter, not authority.

use omnia_session_store::error::{NativeError, NativeResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileRecord {
    pub id: String,
    pub provider_type: String,
    pub display_name: String,
    pub normalized_base_url: String,
    pub auth_scheme: String,
    pub organization_id: Option<String>,
    pub remote_project_id: Option<String>,
    pub credential_status: CredentialStatus,
    pub local_network_grant: bool,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStatus {
    Present,
    Missing,
}

/// Native-only metadata and opaque vault reference captured by one SQL read.
///
/// Intentionally neither Debug nor Serialize. This does not version vault
/// content, fence later edits, or authorize external provider effects.
pub struct ProviderCredentialSnapshot {
    pub profile: ProviderProfileRecord,
    pub credential_ref: Option<String>,
}

/// A borrowed query view; never an independent storage/recovery owner.
pub struct ProviderProfileRepository<'a> {
    connection: &'a Connection,
    app_profile_id: &'a str,
}

impl<'a> ProviderProfileRepository<'a> {
    /// Borrow an existing connection with the scope selected by its owner.
    ///
    /// Methods intentionally do not validate provider IDs; host callers preserve
    /// their validation-before-lock ordering and transaction callers retain their
    /// existing admission checks.
    pub fn new(connection: &'a Connection, app_profile_id: &'a str) -> Self {
        Self {
            connection,
            app_profile_id,
        }
    }

    pub fn list(&self) -> NativeResult<Vec<ProviderProfileRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, provider_type, display_name, normalized_base_url,
                    auth_scheme, organization_id, remote_project_id, credential_ref,
                    egress_policy_json, enabled, created_at_ms, updated_at_ms
             FROM provider_profiles
             WHERE profile_id = ?1 AND deleted_at_ms IS NULL
             ORDER BY updated_at_ms DESC, id DESC",
        )?;
        let records = statement
            .query_map([self.app_profile_id], provider_profile_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    /// Read undeleted metadata, including disabled providers.
    pub fn get(&self, provider_id: &str) -> NativeResult<ProviderProfileRecord> {
        self.connection
            .query_row(
                "SELECT id, provider_type, display_name, normalized_base_url,
                        auth_scheme, organization_id, remote_project_id, credential_ref,
                        egress_policy_json, enabled, created_at_ms, updated_at_ms
                 FROM provider_profiles
                 WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL",
                params![provider_id, self.app_profile_id],
                provider_profile_from_row,
            )
            .optional()?
            .ok_or_else(missing_profile)
    }

    /// Read renderer-safe metadata for an enabled, undeleted provider.
    pub fn active(&self, provider_id: &str) -> NativeResult<ProviderProfileRecord> {
        self.connection
            .query_row(
                "SELECT id, provider_type, display_name, normalized_base_url,
                        auth_scheme, organization_id, remote_project_id, credential_ref,
                        egress_policy_json, enabled, created_at_ms, updated_at_ms
                 FROM provider_profiles
                 WHERE id = ?1 AND profile_id = ?2
                   AND deleted_at_ms IS NULL AND enabled = 1",
                params![provider_id, self.app_profile_id],
                provider_profile_from_row,
            )
            .optional()?
            .ok_or_else(missing_profile)
    }

    /// Capture profile and opaque reference from one enabled, undeleted row.
    pub fn credential_snapshot(
        &self,
        provider_id: &str,
    ) -> NativeResult<ProviderCredentialSnapshot> {
        self.connection
            .query_row(
                "SELECT id, provider_type, display_name, normalized_base_url,
                        auth_scheme, organization_id, remote_project_id, credential_ref,
                        egress_policy_json, enabled, created_at_ms, updated_at_ms
                 FROM provider_profiles
                 WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL AND enabled = 1",
                params![provider_id, self.app_profile_id],
                |row| {
                    Ok(ProviderCredentialSnapshot {
                        profile: provider_profile_from_row(row)?,
                        credential_ref: row.get(7)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(missing_profile)
    }

    /// Return a nullable opaque reference; missing rows remain errors.
    pub fn credential_ref(&self, provider_id: &str) -> NativeResult<Option<String>> {
        self.connection
            .query_row(
                "SELECT credential_ref FROM provider_profiles
                 WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL AND enabled = 1",
                params![provider_id, self.app_profile_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(missing_profile)
    }
}

fn missing_profile() -> NativeError {
    NativeError::new(
        "provider_profile_missing",
        "The selected provider profile is missing or disabled",
    )
}

/// Decode the canonical twelve-column provider projection in query order.
///
/// Malformed egress metadata retains the existing deny-by-default behavior.
/// Credential status describes reference presence, not successful vault access.
pub fn provider_profile_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProviderProfileRecord> {
    let egress_policy_json: String = row.get(8)?;
    let local_network_grant = serde_json::from_str::<serde_json::Value>(&egress_policy_json)
        .ok()
        .and_then(|value| {
            value
                .get("localNetworkGrant")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    let credential_ref: Option<String> = row.get(7)?;
    Ok(ProviderProfileRecord {
        id: row.get(0)?,
        provider_type: row.get(1)?,
        display_name: row.get(2)?,
        normalized_base_url: row.get(3)?,
        auth_scheme: row.get(4)?,
        organization_id: row.get(5)?,
        remote_project_id: row.get(6)?,
        credential_status: if credential_ref.is_some() {
            CredentialStatus::Present
        } else {
            CredentialStatus::Missing
        },
        local_network_grant,
        enabled: row.get(9)?,
        created_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE provider_profiles (
                    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
                    provider_type TEXT NOT NULL, display_name TEXT NOT NULL,
                    normalized_base_url TEXT NOT NULL, auth_scheme TEXT NOT NULL,
                    organization_id TEXT, remote_project_id TEXT, credential_ref TEXT,
                    egress_policy_json TEXT NOT NULL, enabled INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
                    deleted_at_ms INTEGER
                 );",
            )
            .unwrap();
        connection
    }

    fn insert(connection: &Connection, id: &str, scope: &str, updated: i64) {
        connection
            .execute(
                "INSERT INTO provider_profiles
                 VALUES (?1,?2,'openai','Provider','https://example.com/v1','bearer',
                    'org','project','opaque-fixture-reference',
                    '{\"localNetworkGrant\":true}',1,10,?3,NULL)",
                params![id, scope, updated],
            )
            .unwrap();
    }

    #[test]
    fn list_orders_by_updated_then_id_descending_and_keeps_disabled() {
        let connection = fixture();
        insert(&connection, "provider_a", "app", 20);
        insert(&connection, "provider_b", "app", 20);
        insert(&connection, "provider_c", "app", 30);
        connection
            .execute(
                "UPDATE provider_profiles SET enabled=0 WHERE id='provider_b'",
                [],
            )
            .unwrap();
        let records = ProviderProfileRepository::new(&connection, "app")
            .list()
            .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec!["provider_c", "provider_b", "provider_a"]
        );
        assert!(!records[1].enabled);
    }

    #[test]
    fn disabled_metadata_remains_visible_but_is_not_dispatch_eligible() {
        let connection = fixture();
        insert(&connection, "provider_a", "app", 20);
        connection
            .execute("UPDATE provider_profiles SET enabled=0", [])
            .unwrap();
        let repository = ProviderProfileRepository::new(&connection, "app");
        assert!(!repository.get("provider_a").unwrap().enabled);
        assert_eq!(
            repository.active("provider_a").unwrap_err().code,
            "provider_profile_missing"
        );
        assert_eq!(
            repository
                .credential_snapshot("provider_a")
                .err()
                .unwrap()
                .code,
            "provider_profile_missing"
        );
        assert_eq!(
            repository.credential_ref("provider_a").unwrap_err().code,
            "provider_profile_missing"
        );
    }

    #[test]
    fn deleted_foreign_scope_and_missing_rows_are_filtered_by_every_query() {
        let connection = fixture();
        insert(&connection, "deleted", "app", 20);
        insert(&connection, "foreign", "other", 20);
        connection
            .execute(
                "UPDATE provider_profiles SET deleted_at_ms=30 WHERE id='deleted'",
                [],
            )
            .unwrap();
        let repository = ProviderProfileRepository::new(&connection, "app");
        assert!(repository.list().unwrap().is_empty());
        for id in ["deleted", "foreign", "missing", "' OR 1=1 --"] {
            assert_eq!(
                repository.get(id).unwrap_err().code,
                "provider_profile_missing"
            );
            assert_eq!(
                repository.active(id).unwrap_err().code,
                "provider_profile_missing"
            );
            assert_eq!(
                repository.credential_snapshot(id).err().unwrap().code,
                "provider_profile_missing"
            );
            assert_eq!(
                repository.credential_ref(id).unwrap_err().code,
                "provider_profile_missing"
            );
        }
        assert_eq!(
            ProviderProfileRepository::new(&connection, "other")
                .get("foreign")
                .unwrap()
                .id,
            "foreign"
        );
    }

    #[test]
    fn snapshot_and_reference_preserve_nullable_and_empty_reference_semantics() {
        let connection = fixture();
        insert(&connection, "provider_a", "app", 20);
        let repository = ProviderProfileRepository::new(&connection, "app");
        let initial = repository.credential_snapshot("provider_a").unwrap();
        assert_eq!(initial.profile.credential_status, CredentialStatus::Present);
        assert_eq!(
            initial.credential_ref.as_deref(),
            Some("opaque-fixture-reference")
        );
        connection
            .execute("UPDATE provider_profiles SET credential_ref=NULL", [])
            .unwrap();
        assert!(repository.credential_ref("provider_a").unwrap().is_none());
        let missing = repository.credential_snapshot("provider_a").unwrap();
        assert!(missing.credential_ref.is_none());
        assert_eq!(missing.profile.credential_status, CredentialStatus::Missing);
        connection
            .execute("UPDATE provider_profiles SET credential_ref=''", [])
            .unwrap();
        let empty = repository.credential_snapshot("provider_a").unwrap();
        assert_eq!(empty.credential_ref.as_deref(), Some(""));
        assert_eq!(empty.profile.credential_status, CredentialStatus::Present);
        // Existing captured metadata/reference remains an owned snapshot.
        assert_eq!(
            initial.credential_ref.as_deref(),
            Some("opaque-fixture-reference")
        );
    }

    #[test]
    fn serialized_metadata_uses_existing_names_and_omits_opaque_reference() {
        let connection = fixture();
        insert(&connection, "provider_a", "app", 20);
        let record = ProviderProfileRepository::new(&connection, "app")
            .get("provider_a")
            .unwrap();
        let value = serde_json::to_value(record).unwrap();
        assert_eq!(value["credentialStatus"], "present");
        assert_eq!(value["normalizedBaseUrl"], "https://example.com/v1");
        assert_eq!(value["organizationId"], "org");
        assert_eq!(value["remoteProjectId"], "project");
        assert_eq!(value["localNetworkGrant"], true);
        assert_eq!(value.as_object().unwrap().len(), 12);
        let serialized = value.to_string();
        assert!(!serialized.contains("opaque-fixture-reference"));
        assert!(!serialized.contains("credentialRef"));
        assert!(!serialized.contains("credential_ref"));
    }

    #[test]
    fn malformed_or_nonboolean_egress_defaults_to_false() {
        let connection = fixture();
        insert(&connection, "provider_a", "app", 20);
        let repository = ProviderProfileRepository::new(&connection, "app");
        assert!(repository.active("provider_a").unwrap().local_network_grant);
        for json in [
            "{",
            "{}",
            "null",
            "[]",
            r#"{"localNetworkGrant":"true"}"#,
            r#"{"localNetworkGrant":1}"#,
            r#"{"localNetworkGrant":false}"#,
        ] {
            connection
                .execute("UPDATE provider_profiles SET egress_policy_json=?1", [json])
                .unwrap();
            assert!(!repository.active("provider_a").unwrap().local_network_grant);
        }
    }

    #[test]
    fn absent_schema_returns_native_database_error_without_creating_tables() {
        let connection = Connection::open_in_memory().unwrap();
        let repository = ProviderProfileRepository::new(&connection, "app");
        for error in [
            repository.list().err().unwrap(),
            repository.get("provider_a").err().unwrap(),
            repository.active("provider_a").err().unwrap(),
            repository.credential_snapshot("provider_a").err().unwrap(),
            repository.credential_ref("provider_a").err().unwrap(),
        ] {
            assert_eq!(error.code, "storage_failed");
            assert!(!error.message.contains("provider_profiles"));
        }
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
}
