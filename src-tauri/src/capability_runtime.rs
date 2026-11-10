use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

/// User-facing effort values accepted by the renderer. `ultra` is a policy,
/// not a provider value: it resolves to the highest capability explicitly
/// advertised by the selected adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestedEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl RequestedEffort {
    pub const ALL: [Self; 8] = [
        Self::None,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Xhigh,
        Self::Max,
        Self::Ultra,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

/// Native adapters publish only values that they can actually encode for the
/// model. The list is normalized and sorted before it is hashed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapability {
    pub provider_profile_id: String,
    pub model_id: String,
    pub adapter_revision: String,
    pub supported_efforts: Vec<String>,
    pub dynamic_workflow: bool,
}

impl ModelCapability {
    pub fn new(
        provider_profile_id: impl Into<String>,
        model_id: impl Into<String>,
        adapter_revision: impl Into<String>,
        supported_efforts: impl IntoIterator<Item = impl Into<String>>,
        dynamic_workflow: bool,
    ) -> Result<Self, CapabilityError> {
        let mut values = supported_efforts
            .into_iter()
            .map(Into::into)
            .map(|value| value.trim().to_ascii_lowercase())
            .collect::<Vec<_>>();
        values.sort();
        values.dedup();
        if values.iter().any(|value| !is_provider_effort(value)) {
            return Err(CapabilityError::InvalidCapability(
                "supported effort values must be none|minimal|low|medium|high|xhigh|max",
            ));
        }
        let profile = bounded_id(provider_profile_id.into(), "providerProfileId")?;
        let model = bounded_id(model_id.into(), "modelId")?;
        let adapter = bounded_id(adapter_revision.into(), "adapterRevision")?;
        Ok(Self {
            provider_profile_id: profile,
            model_id: model,
            adapter_revision: adapter,
            supported_efforts: values,
            dynamic_workflow,
        })
    }

    pub fn capability_hash(&self) -> String {
        // Serialization is deterministic because the struct field order and
        // supported_efforts sorting are controlled above.
        sha256_json(self).expect("capability is serializable")
    }

    fn supports(&self, value: &str) -> bool {
        self.supported_efforts.iter().any(|entry| entry == value)
    }

    fn highest(&self) -> Option<&'static str> {
        RequestedEffort::ALL
            .iter()
            .filter_map(|effort| {
                let value = effort.as_str();
                (value != "ultra" && self.supports(value)).then_some(value)
            })
            .max_by_key(|value| effort_rank(value))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    pub session_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub requested: RequestedEffort,
    pub settings_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NegotiationStatus {
    Applied,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptAction {
    Initial,
    HotChange,
    Rejected,
}

/// This is the native runtime receipt. It is intentionally secret-free and
/// can be persisted by the native storage layer or returned to the renderer.
/// `previous_receipt_hash` makes a session's settings lineage tamper evident.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRuntimeReceipt {
    pub receipt_id: String,
    pub session_id: String,
    pub provider_profile_id: String,
    pub model_id: String,
    pub requested: RequestedEffort,
    pub effective: Option<String>,
    pub status: NegotiationStatus,
    pub action: ReceiptAction,
    pub settings_revision: u64,
    pub session_revision: u64,
    pub capability_hash: String,
    pub adapter_revision: String,
    pub previous_receipt_hash: Option<String>,
    pub receipt_hash: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapabilityError {
    InvalidCapability(&'static str),
    InvalidInput(&'static str),
    ScopeConflict(&'static str),
    StaleRevision { expected: u64, received: u64 },
    CorruptJournal(&'static str),
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCapability(message)
            | Self::InvalidInput(message)
            | Self::ScopeConflict(message)
            | Self::CorruptJournal(message) => output.write_str(message),
            Self::StaleRevision { expected, received } => write!(
                output,
                "settings revision is stale: expected {expected}, received {received}"
            ),
        }
    }
}

impl std::error::Error for CapabilityError {}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRuntimeJournal {
    receipts: Vec<CapabilityRuntimeReceipt>,
}

#[derive(Clone, Debug, Default)]
pub struct CapabilityRuntimeStore {
    journal: CapabilityRuntimeJournal,
    sessions: BTreeMap<String, SessionState>,
}

#[derive(Clone, Debug)]
struct SessionState {
    settings_revision: u64,
    session_revision: u64,
    last_receipt_hash: Option<String>,
    has_applied: bool,
}

impl CapabilityRuntimeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_journal(journal: CapabilityRuntimeJournal) -> Result<Self, CapabilityError> {
        let mut store = Self::new();
        let mut previous_by_session: HashMap<String, CapabilityRuntimeReceipt> = HashMap::new();
        for receipt in &journal.receipts {
            let previous = previous_by_session.get(&receipt.session_id);
            validate_receipt(receipt, previous)?;
            let prior = store.sessions.get(&receipt.session_id).cloned();
            store.sessions.insert(
                receipt.session_id.clone(),
                SessionState {
                    settings_revision: if receipt.status == NegotiationStatus::Applied {
                        receipt.settings_revision
                    } else {
                        prior
                            .as_ref()
                            .map_or(receipt.settings_revision, |state| state.settings_revision)
                    },
                    session_revision: receipt.session_revision,
                    last_receipt_hash: Some(receipt.receipt_hash.clone()),
                    has_applied: receipt.status == NegotiationStatus::Applied
                        || prior.as_ref().is_some_and(|state| state.has_applied),
                },
            );
            previous_by_session.insert(receipt.session_id.clone(), receipt.clone());
            store.journal.receipts.push(receipt.clone());
        }
        Ok(store)
    }

    pub fn journal(&self) -> CapabilityRuntimeJournal {
        self.journal.clone()
    }

    pub fn receipts(&self) -> &[CapabilityRuntimeReceipt] {
        &self.journal.receipts
    }

    pub fn negotiate(
        &mut self,
        request: CapabilityRequest,
        capability: &ModelCapability,
    ) -> Result<CapabilityRuntimeReceipt, CapabilityError> {
        self.apply(request, capability, false)
    }

    pub fn hot_change(
        &mut self,
        request: CapabilityRequest,
        capability: &ModelCapability,
    ) -> Result<CapabilityRuntimeReceipt, CapabilityError> {
        self.apply(request, capability, true)
    }

    fn apply(
        &mut self,
        request: CapabilityRequest,
        capability: &ModelCapability,
        hot_change: bool,
    ) -> Result<CapabilityRuntimeReceipt, CapabilityError> {
        let _ = hot_change;
        validate_request(&request)?;
        if request.provider_profile_id != capability.provider_profile_id
            || request.model_id != capability.model_id
        {
            return Err(CapabilityError::ScopeConflict(
                "capability does not belong to requested provider profile and model",
            ));
        }
        let previous = self.sessions.get(&request.session_id).cloned();
        if let Some(state) = &previous {
            if request.settings_revision < state.settings_revision {
                return Err(CapabilityError::StaleRevision {
                    expected: state.settings_revision,
                    received: request.settings_revision,
                });
            }
        }
        let requested = request.requested;
        let effective = resolve_effort(requested, capability);
        let status = if effective.is_some() {
            NegotiationStatus::Applied
        } else {
            NegotiationStatus::Rejected
        };
        let action = if status == NegotiationStatus::Rejected {
            ReceiptAction::Rejected
        } else if previous.as_ref().is_some_and(|state| state.has_applied) {
            ReceiptAction::HotChange
        } else {
            ReceiptAction::Initial
        };
        let session_revision = previous
            .as_ref()
            .map_or(1, |state| state.session_revision.saturating_add(1));
        let reason = (status == NegotiationStatus::Rejected).then(|| {
            if requested == RequestedEffort::Ultra {
                if capability.dynamic_workflow {
                    "ultra requires at least one explicitly supported provider effort".to_owned()
                } else {
                    "ultra requires native dynamic workflow capability".to_owned()
                }
            } else {
                format!("provider does not advertise {}", requested.as_str())
            }
        });
        let previous_receipt_hash = previous
            .as_ref()
            .and_then(|state| state.last_receipt_hash.clone());
        let mut receipt = CapabilityRuntimeReceipt {
            receipt_id: format!(
                "capability-{session_revision}-{}",
                self.journal.receipts.len() + 1
            ),
            session_id: request.session_id,
            provider_profile_id: capability.provider_profile_id.clone(),
            model_id: capability.model_id.clone(),
            requested,
            effective: effective.map(ToOwned::to_owned),
            status,
            action,
            settings_revision: request.settings_revision,
            session_revision,
            capability_hash: capability.capability_hash(),
            adapter_revision: capability.adapter_revision.clone(),
            previous_receipt_hash,
            receipt_hash: String::new(),
            reason,
        };
        receipt.receipt_hash = receipt_hash(&receipt)?;
        self.journal.receipts.push(receipt.clone());
        let prior = self.sessions.get(&receipt.session_id).cloned();
        self.sessions.insert(
            receipt.session_id.clone(),
            SessionState {
                settings_revision: if receipt.status == NegotiationStatus::Applied {
                    receipt.settings_revision
                } else {
                    prior
                        .as_ref()
                        .map_or(receipt.settings_revision, |state| state.settings_revision)
                },
                session_revision: receipt.session_revision,
                last_receipt_hash: Some(receipt.receipt_hash.clone()),
                has_applied: receipt.status == NegotiationStatus::Applied
                    || prior.as_ref().is_some_and(|state| state.has_applied),
            },
        );
        Ok(receipt)
    }
}

fn validate_request(request: &CapabilityRequest) -> Result<(), CapabilityError> {
    bounded_id(request.session_id.clone(), "sessionId")?;
    bounded_id(request.provider_profile_id.clone(), "providerProfileId")?;
    bounded_id(request.model_id.clone(), "modelId")?;
    Ok(())
}

fn resolve_effort(
    requested: RequestedEffort,
    capability: &ModelCapability,
) -> Option<&'static str> {
    if requested == RequestedEffort::Ultra {
        if !capability.dynamic_workflow {
            return None;
        }
        return capability.highest();
    }
    capability
        .supports(requested.as_str())
        .then_some(requested.as_str())
}

fn is_provider_effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    )
}

fn effort_rank(value: &str) -> u8 {
    match value {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        "max" => 6,
        _ => 0,
    }
}

fn bounded_id(value: String, field: &'static str) -> Result<String, CapabilityError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(CapabilityError::InvalidInput(field));
    }
    Ok(value)
}

fn sha256_json<T: Serialize>(value: &T) -> Result<String, CapabilityError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| CapabilityError::CorruptJournal("json encode failed"))?;
    Ok(hex_digest(&bytes))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn receipt_hash(receipt: &CapabilityRuntimeReceipt) -> Result<String, CapabilityError> {
    #[derive(Serialize)]
    struct Hashable<'a> {
        receipt_id: &'a str,
        session_id: &'a str,
        provider_profile_id: &'a str,
        model_id: &'a str,
        requested: RequestedEffort,
        effective: &'a Option<String>,
        status: &'a NegotiationStatus,
        action: &'a ReceiptAction,
        settings_revision: u64,
        session_revision: u64,
        capability_hash: &'a str,
        adapter_revision: &'a str,
        previous_receipt_hash: &'a Option<String>,
        reason: &'a Option<String>,
    }
    sha256_json(&Hashable {
        receipt_id: &receipt.receipt_id,
        session_id: &receipt.session_id,
        provider_profile_id: &receipt.provider_profile_id,
        model_id: &receipt.model_id,
        requested: receipt.requested,
        effective: &receipt.effective,
        status: &receipt.status,
        action: &receipt.action,
        settings_revision: receipt.settings_revision,
        session_revision: receipt.session_revision,
        capability_hash: &receipt.capability_hash,
        adapter_revision: &receipt.adapter_revision,
        previous_receipt_hash: &receipt.previous_receipt_hash,
        reason: &receipt.reason,
    })
}

fn validate_receipt(
    receipt: &CapabilityRuntimeReceipt,
    previous: Option<&CapabilityRuntimeReceipt>,
) -> Result<(), CapabilityError> {
    if receipt.receipt_hash != receipt_hash(receipt)? {
        return Err(CapabilityError::CorruptJournal("receipt hash mismatch"));
    }
    if receipt.session_revision == 0 {
        return Err(CapabilityError::CorruptJournal(
            "session revision must be positive",
        ));
    }
    if receipt.status == NegotiationStatus::Applied && receipt.effective.is_none() {
        return Err(CapabilityError::CorruptJournal(
            "applied receipt lacks effective effort",
        ));
    }
    if let Some(previous) = previous {
        if receipt.previous_receipt_hash.as_deref() != Some(previous.receipt_hash.as_str()) {
            return Err(CapabilityError::CorruptJournal("receipt lineage is broken"));
        }
    } else if receipt.previous_receipt_hash.is_some() {
        return Err(CapabilityError::CorruptJournal(
            "first receipt cannot have a predecessor",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability(values: &[&str]) -> ModelCapability {
        ModelCapability::new(
            "profile-1",
            "model-1",
            "adapter-v3",
            values.iter().copied(),
            true,
        )
        .expect("valid capability")
    }

    fn request(session: &str, requested: RequestedEffort, revision: u64) -> CapabilityRequest {
        CapabilityRequest {
            session_id: session.to_owned(),
            provider_profile_id: "profile-1".to_owned(),
            model_id: "model-1".to_owned(),
            requested,
            settings_revision: revision,
        }
    }

    #[test]
    fn capability_normalizes_and_hashes_deterministically() {
        let left = capability(&["HIGH", "low", "low"]);
        let right = capability(&["low", "high"]);
        assert_eq!(left, right);
        assert_eq!(left.capability_hash(), right.capability_hash());
    }

    #[test]
    fn supported_effort_applies_exact_value() {
        let mut store = CapabilityRuntimeStore::new();
        let receipt = store
            .negotiate(
                request("session-1", RequestedEffort::High, 1),
                &capability(&["high"]),
            )
            .expect("supported effort");
        assert_eq!(receipt.status, NegotiationStatus::Applied);
        assert_eq!(receipt.effective.as_deref(), Some("high"));
        assert_eq!(receipt.action, ReceiptAction::Initial);
    }

    #[test]
    fn unsupported_effort_is_fail_closed_and_receipted() {
        let mut store = CapabilityRuntimeStore::new();
        let receipt = store
            .negotiate(
                request("session-1", RequestedEffort::Xhigh, 1),
                &capability(&["high"]),
            )
            .expect("rejection is a receipt, not a transport failure");
        assert_eq!(receipt.status, NegotiationStatus::Rejected);
        assert_eq!(receipt.effective, None);
        assert!(receipt.reason.as_deref().unwrap().contains("xhigh"));
    }

    #[test]
    fn ultra_resolves_to_highest_advertised_effort() {
        let mut store = CapabilityRuntimeStore::new();
        let receipt = store
            .negotiate(
                request("session-1", RequestedEffort::Ultra, 1),
                &capability(&["low", "max", "xhigh"]),
            )
            .expect("ultra policy");
        assert_eq!(receipt.effective.as_deref(), Some("max"));
        assert_eq!(receipt.status, NegotiationStatus::Applied);
    }

    #[test]
    fn ultra_without_provider_effort_is_rejected() {
        let mut store = CapabilityRuntimeStore::new();
        let receipt = store
            .negotiate(
                request("session-1", RequestedEffort::Ultra, 1),
                &capability(&[]),
            )
            .expect("policy rejection");
        assert_eq!(receipt.status, NegotiationStatus::Rejected);
        assert!(receipt.reason.as_deref().unwrap().contains("ultra"));
    }

    #[test]
    fn ultra_without_dynamic_workflow_is_rejected_even_with_max_effort() {
        let mut store = CapabilityRuntimeStore::new();
        let capability = ModelCapability::new("profile-1", "model-1", "adapter-v3", ["max"], false)
            .expect("valid capability");
        let receipt = store
            .negotiate(request("session-1", RequestedEffort::Ultra, 1), &capability)
            .expect("policy rejection");
        assert_eq!(receipt.status, NegotiationStatus::Rejected);
        assert!(receipt
            .reason
            .as_deref()
            .unwrap()
            .contains("dynamic workflow"));
    }

    #[test]
    fn xhigh_is_applied_when_native_adapter_advertises_it() {
        let mut store = CapabilityRuntimeStore::new();
        let receipt = store
            .negotiate(
                request("session-1", RequestedEffort::Xhigh, 1),
                &capability(&["xhigh"]),
            )
            .expect("xhigh adapter capability");
        assert_eq!(receipt.status, NegotiationStatus::Applied);
        assert_eq!(receipt.effective.as_deref(), Some("xhigh"));
    }

    #[test]
    fn scope_conflict_cannot_apply_another_model_capability() {
        let mut store = CapabilityRuntimeStore::new();
        let mut request = request("session-1", RequestedEffort::Low, 1);
        request.model_id = "model-2".to_owned();
        let error = store
            .negotiate(request, &capability(&["low"]))
            .expect_err("scope must fail closed");
        assert_eq!(
            error,
            CapabilityError::ScopeConflict(
                "capability does not belong to requested provider profile and model"
            )
        );
    }

    #[test]
    fn hot_change_increments_session_revision_and_chains_receipts() {
        let mut store = CapabilityRuntimeStore::new();
        let first = store
            .negotiate(
                request("session-1", RequestedEffort::Low, 1),
                &capability(&["low", "high"]),
            )
            .expect("initial");
        let second = store
            .hot_change(
                request("session-1", RequestedEffort::High, 2),
                &capability(&["low", "high"]),
            )
            .expect("hot change");
        assert_eq!(second.action, ReceiptAction::HotChange);
        assert_eq!(second.session_revision, 2);
        assert_eq!(
            second.previous_receipt_hash.as_deref(),
            Some(first.receipt_hash.as_str())
        );
    }

    #[test]
    fn stale_settings_revision_is_rejected_without_appending_receipt() {
        let mut store = CapabilityRuntimeStore::new();
        store
            .negotiate(
                request("session-1", RequestedEffort::Low, 4),
                &capability(&["low", "high"]),
            )
            .expect("initial");
        let before = store.receipts().len();
        let error = store
            .hot_change(
                request("session-1", RequestedEffort::High, 3),
                &capability(&["low", "high"]),
            )
            .expect_err("stale revision");
        assert_eq!(
            error,
            CapabilityError::StaleRevision {
                expected: 4,
                received: 3
            }
        );
        assert_eq!(store.receipts().len(), before);
    }

    #[test]
    fn journal_round_trip_reconstructs_session_state() {
        let mut store = CapabilityRuntimeStore::new();
        store
            .negotiate(
                request("session-1", RequestedEffort::Low, 1),
                &capability(&["low", "high"]),
            )
            .expect("initial");
        store
            .hot_change(
                request("session-1", RequestedEffort::High, 2),
                &capability(&["low", "high"]),
            )
            .expect("change");
        let journal = store.journal();
        let mut restored = CapabilityRuntimeStore::from_journal(journal).expect("valid journal");
        let next = restored
            .hot_change(
                request("session-1", RequestedEffort::Low, 3),
                &capability(&["low", "high"]),
            )
            .expect("restored state");
        assert_eq!(next.session_revision, 3);
        assert_eq!(next.action, ReceiptAction::HotChange);
    }

    #[test]
    fn rejected_receipt_remains_in_lineage_after_restore() {
        let mut store = CapabilityRuntimeStore::new();
        let rejected = store
            .negotiate(
                request("session-1", RequestedEffort::Xhigh, 1),
                &capability(&["low"]),
            )
            .expect("rejection is journaled");
        let journal = store.journal();
        let mut restored = CapabilityRuntimeStore::from_journal(journal).expect("valid journal");
        let applied = restored
            .hot_change(
                request("session-1", RequestedEffort::Low, 2),
                &capability(&["low"]),
            )
            .expect("supported hot change");
        assert_eq!(
            applied.previous_receipt_hash.as_deref(),
            Some(rejected.receipt_hash.as_str())
        );
        assert_eq!(applied.session_revision, 2);
    }

    #[test]
    fn tampered_receipt_is_rejected_on_restore() {
        let mut store = CapabilityRuntimeStore::new();
        store
            .negotiate(
                request("session-1", RequestedEffort::Low, 1),
                &capability(&["low"]),
            )
            .expect("initial");
        let mut journal = store.journal();
        journal.receipts[0].effective = Some("max".to_owned());
        let error = CapabilityRuntimeStore::from_journal(journal).expect_err("tamper");
        assert_eq!(
            error,
            CapabilityError::CorruptJournal("receipt hash mismatch")
        );
    }

    #[test]
    fn invalid_provider_value_is_rejected() {
        let error = ModelCapability::new("p", "m", "a", ["unsupported"], false)
            .expect_err("unknown native effort must fail closed");
        assert_eq!(
            error,
            CapabilityError::InvalidCapability(
                "supported effort values must be none|minimal|low|medium|high|xhigh|max"
            )
        );
    }
}
