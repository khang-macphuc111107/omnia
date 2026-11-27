use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Mutex;

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

/// Default bounded message retention cap for [`PeerMeshGraph`] (`AUD-11` / `AUD-19`).
pub const DEFAULT_MAX_RETAINED_MESSAGES: usize = 4_096;

/// Errors produced by [`PeerMeshGraph`] or [`crate::GraphifyIndex`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentGraphError {
    #[error("invalid agent id `{0}`: must be 1..=64 chars in [A-Za-z0-9._-]")]
    InvalidAgentId(String),
    #[error("unknown agent `{0}`")]
    UnknownAgent(String),
    #[error("agent `{0}` is inactive")]
    InactiveAgent(String),
    #[error("cannot create self-link on agent `{0}`")]
    SelfLink(String),
    #[error("peers `{from}` and `{to}` do not share a required directional link")]
    UnlinkedPeers { from: String, to: String },
    #[error("disjoint path ownership conflict between `{first}` and `{second}` on `{path}`")]
    OwnershipConflict {
        first: String,
        second: String,
        path: String,
    },
    #[error("hop budget exceeded at hop {hop_count} (max {max_hops})")]
    HopBudgetExceeded { hop_count: u32, max_hops: u32 },
    #[error("stale epoch for `{agent_id}`: expected >= {current_epoch}, got {provided_epoch}")]
    StaleEpoch {
        agent_id: String,
        current_epoch: u64,
        provided_epoch: u64,
    },
    #[error("unknown message sequence `{0}`")]
    UnknownMessageSeq(u64),
    #[error("invalid owned or excluded path `{0}`")]
    InvalidOwnedPath(String),
    #[error("agent `{from}` is not an authorized recipient of message seq {seq}")]
    UnauthorizedReply { from: String, seq: u64 },
    #[error("invalid graph entity id `{0}`")]
    InvalidEntityId(String),
    #[error("unknown graph entity `{0}`")]
    UnknownEntity(String),
    #[error("workspace indexing i/o error: {0}")]
    IoError(String),
    #[error("internal graph lock poisoned")]
    InternalLockPoisoned,
}

/// Collaboration role assigned to an agent participant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AgentRole {
    Coordinator,
    Worker,
    Specialist,
    Verifier,
    Subagent,
}

impl AgentRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Coordinator => "coordinator",
            Self::Worker => "worker",
            Self::Specialist => "specialist",
            Self::Verifier => "verifier",
            Self::Subagent => "subagent",
        }
    }
}

/// Registered participant node in the bidirectional peer mesh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentNode {
    pub id: String,
    pub role: AgentRole,
    pub epoch: u64,
    pub active: bool,
    pub owned_paths: Vec<String>,
    pub excluded_paths: Vec<String>,
    pub last_read_seq: u64,
}

impl AgentNode {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "role": self.role.as_str(),
            "epoch": self.epoch,
            "active": self.active,
            "owned_paths": self.owned_paths,
            "excluded_paths": self.excluded_paths,
            "last_read_seq": self.last_read_seq,
        })
    }
}

/// Directed communication edge (bidirectional duplex = two opposite `PeerLinkEdge`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerLinkEdge {
    pub from_id: String,
    pub to_id: String,
    pub channel_label: String,
}

impl PeerLinkEdge {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "from_id": self.from_id,
            "to_id": self.to_id,
            "channel_label": self.channel_label,
        })
    }
}

/// Envelope delivered over the peer mesh with hop and epoch cycle guards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerMessage {
    pub seq: u64,
    pub from_id: String,
    pub recipients: Vec<String>,
    pub epoch: u64,
    pub hop_count: u32,
    pub max_hops: u32,
    pub in_reply_to_seq: Option<u64>,
    pub topic: String,
    pub payload: String,
    pub sent_at_ms: i64,
}

impl PeerMessage {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "seq": self.seq,
            "from_id": self.from_id,
            "recipients": self.recipients,
            "epoch": self.epoch,
            "hop_count": self.hop_count,
            "max_hops": self.max_hops,
            "in_reply_to_seq": self.in_reply_to_seq,
            "topic": SecretRedactor::redact(&self.topic),
            "payload": SecretRedactor::redact(&self.payload),
            "sent_at_ms": self.sent_at_ms,
        }))
    }
}

impl Serialize for PeerMessage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Alert emitted when an active peer has stale unread messages beyond the stall threshold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StalledPeerAlert {
    pub agent_id: String,
    pub unread_count: usize,
    pub oldest_unread_seq: u64,
    pub oldest_unread_ms: i64,
    pub idle_for_ms: i64,
}

impl StalledPeerAlert {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "agent_id": self.agent_id,
            "unread_count": self.unread_count,
            "oldest_unread_seq": self.oldest_unread_seq,
            "oldest_unread_ms": self.oldest_unread_ms,
            "idle_for_ms": self.idle_for_ms,
        })
    }
}

/// Overall convergence status summary across registered mesh participants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvergenceReport {
    pub active_agents: usize,
    pub total_messages: usize,
    pub pending_unread_deliveries: usize,
    pub stalled_agents: Vec<StalledPeerAlert>,
    pub converged: bool,
}

impl ConvergenceReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let stalled: Vec<Value> = self
            .stalled_agents
            .iter()
            .map(StalledPeerAlert::to_json)
            .collect();
        json!({
            "active_agents": self.active_agents,
            "total_messages": self.total_messages,
            "pending_unread_deliveries": self.pending_unread_deliveries,
            "stalled_agents": stalled,
            "converged": self.converged,
        })
    }
}

/// Validate a peer agent identifier (`1..=64` ASCII `[A-Za-z0-9._-]`).
#[must_use]
pub fn valid_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Strictly validates and normalizes a repository-relative path for disjoint ownership checks
/// (`AUD-26` + PR #1 hardening): rejects absolute/drive/UNC paths, colons/ADS, control chars,
/// `?<>"|`, trailing `.` or space on segments, mid-path wildcards, and root-escaping `..`.
pub fn validate_and_normalize_repo_path(path: &str) -> Result<String, AgentGraphError> {
    let trimmed = path.trim_matches([' ', '\t', '\r', '\n']);
    if trimmed.is_empty() {
        return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
    }
    if trimmed.chars().any(|c| {
        (c as u32) < 0x20
            || c == '\x7F'
            || matches!(c, ':' | '?' | '<' | '>' | '"' | '|')
    }) {
        return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
    }
    let replaced = trimmed.replace('\\', "/");
    if replaced.starts_with('/') {
        return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
    }
    let mut s = replaced.as_str();
    while let Some(rest) = s.strip_prefix("./") {
        s = rest;
    }
    if s == "**" || s == "*" {
        return Ok("*".to_owned());
    }
    let mut owned = s.to_owned();
    loop {
        if let Some(rest) = owned.strip_suffix("/**") {
            owned = rest.to_owned();
        } else if let Some(rest) = owned.strip_suffix("/*") {
            owned = rest.to_owned();
        } else if owned.len() > 1 && owned.ends_with('/') {
            owned.pop();
        } else {
            break;
        }
    }
    if owned.contains('*') {
        return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in owned.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if parts.pop().is_none() {
                return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
            }
            continue;
        }
        if seg.ends_with('.') || seg.ends_with(' ') || seg.starts_with(' ') {
            return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
        }
        parts.push(seg);
    }
    if parts.is_empty() {
        return Err(AgentGraphError::InvalidOwnedPath(path.to_owned()));
    }
    let mut normalized = parts.join("/");
    #[cfg(windows)]
    {
        normalized = normalized.to_lowercase();
    }
    Ok(normalized)
}

/// Normalize a repository-relative path for deterministic `disjoint_paths` comparison.
/// Collapses `.` and `..` segments lexically and returns an empty string on invalid/escaping paths.
#[must_use]
pub fn normalize_repo_path(path: &str) -> String {
    validate_and_normalize_repo_path(path).unwrap_or_default()
}

/// Return true if normalized `parent` covers normalized `child` (or is `*`).
#[must_use]
pub fn prefix_covers(parent: &str, child: &str) -> bool {
    if parent.is_empty() || child.is_empty() {
        return false;
    }
    if parent == "*" || parent == child {
        return true;
    }
    if child.starts_with(parent) {
        return child.as_bytes().get(parent.len()) == Some(&b'/');
    }
    false
}

fn is_carved_out(owned: &str, target: &str, exclusions: &[String]) -> bool {
    if !prefix_covers(owned, target) {
        return false;
    }
    exclusions.iter().any(|ex| {
        let nex = normalize_repo_path(ex);
        prefix_covers(&nex, target)
    })
}

fn find_effective_overlap(a: &AgentNode, b: &AgentNode) -> Option<String> {
    for raw_a in &a.owned_paths {
        let na = normalize_repo_path(raw_a);
        if na.is_empty() {
            continue;
        }
        for raw_b in &b.owned_paths {
            let nb = normalize_repo_path(raw_b);
            if nb.is_empty() {
                continue;
            }
            if prefix_covers(&na, &nb) {
                if !is_carved_out(&na, &nb, &a.excluded_paths) {
                    return Some(nb);
                }
            } else if prefix_covers(&nb, &na) && !is_carved_out(&nb, &na, &b.excluded_paths) {
                return Some(na);
            }
        }
    }
    None
}

#[derive(Debug)]
struct MeshInner {
    default_max_hops: u32,
    max_retained_messages: usize,
    next_seq: u64,
    agents: BTreeMap<String, AgentNode>,
    edges: BTreeMap<(String, String), String>,
    messages: VecDeque<PeerMessage>,
}

/// Bidirectional all-to-all peer mesh with disjoint-path ownership enforcement,
/// cursor-based delivery (`read_since`), and `max_hops` / `epoch` cycle guards.
#[derive(Debug)]
pub struct PeerMeshGraph {
    inner: Mutex<MeshInner>,
}

impl Default for PeerMeshGraph {
    fn default() -> Self {
        Self::new(12)
    }
}

impl PeerMeshGraph {
    #[must_use]
    pub fn new(default_max_hops: u32) -> Self {
        Self::with_retention(default_max_hops, DEFAULT_MAX_RETAINED_MESSAGES)
    }

    /// Construct a peer mesh with an explicit bounded message retention cap (`>= 1`).
    #[must_use]
    pub fn with_retention(default_max_hops: u32, max_retained_messages: usize) -> Self {
        Self {
            inner: Mutex::new(MeshInner {
                default_max_hops: default_max_hops.max(1),
                max_retained_messages: max_retained_messages.max(1),
                next_seq: 1,
                agents: BTreeMap::new(),
                edges: BTreeMap::new(),
                messages: VecDeque::new(),
            }),
        }
    }

    pub fn register_agent(
        &self,
        id: &str,
        role: AgentRole,
        owned_paths: Vec<String>,
        excluded_paths: Vec<String>,
    ) -> Result<AgentNode, AgentGraphError> {
        if !valid_agent_id(id) {
            return Err(AgentGraphError::InvalidAgentId(id.to_owned()));
        }
        for p in &owned_paths {
            let _ = validate_and_normalize_repo_path(p)?;
        }
        for p in &excluded_paths {
            let _ = validate_and_normalize_repo_path(p)?;
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;

        let existing = guard.agents.get(id).cloned();
        let candidate = AgentNode {
            id: id.to_owned(),
            role,
            epoch: existing.as_ref().map_or(1, |prev| prev.epoch),
            active: existing.as_ref().is_none_or(|prev| prev.active),
            owned_paths,
            excluded_paths,
            last_read_seq: existing.map_or(0, |prev| prev.last_read_seq),
        };

        for (other_id, other_node) in &guard.agents {
            if other_id == id || !other_node.active {
                continue;
            }
            if let Some(conflict_path) = find_effective_overlap(&candidate, other_node) {
                return Err(AgentGraphError::OwnershipConflict {
                    first: id.to_owned(),
                    second: other_id.clone(),
                    path: conflict_path,
                });
            }
        }

        guard.agents.insert(id.to_owned(), candidate.clone());
        Ok(candidate)
    }

    pub fn agent(&self, id: &str) -> Result<Option<AgentNode>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.agents.get(id).cloned())
    }

    pub fn agents(&self) -> Result<Vec<AgentNode>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.agents.values().cloned().collect())
    }

    pub fn bump_agent_epoch(&self, id: &str) -> Result<u64, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        let node = guard
            .agents
            .get_mut(id)
            .ok_or_else(|| AgentGraphError::UnknownAgent(id.to_owned()))?;
        node.epoch = node.epoch.saturating_add(1);
        Ok(node.epoch)
    }

    pub fn set_agent_active(&self, id: &str, active: bool) -> Result<(), AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        if active {
            let candidate = guard
                .agents
                .get(id)
                .cloned()
                .ok_or_else(|| AgentGraphError::UnknownAgent(id.to_owned()))?;
            for (other_id, other_node) in &guard.agents {
                if other_id == id || !other_node.active {
                    continue;
                }
                if let Some(conflict_path) = find_effective_overlap(&candidate, other_node) {
                    return Err(AgentGraphError::OwnershipConflict {
                        first: id.to_owned(),
                        second: other_id.clone(),
                        path: conflict_path,
                    });
                }
            }
        }
        let node = guard
            .agents
            .get_mut(id)
            .ok_or_else(|| AgentGraphError::UnknownAgent(id.to_owned()))?;
        node.active = active;
        Ok(())
    }

    pub fn connect_directed(
        &self,
        from_id: &str,
        to_id: &str,
        channel_label: &str,
    ) -> Result<(), AgentGraphError> {
        if from_id == to_id {
            return Err(AgentGraphError::SelfLink(from_id.to_owned()));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        if !guard.agents.contains_key(from_id) {
            return Err(AgentGraphError::UnknownAgent(from_id.to_owned()));
        }
        if !guard.agents.contains_key(to_id) {
            return Err(AgentGraphError::UnknownAgent(to_id.to_owned()));
        }
        guard.edges.insert(
            (from_id.to_owned(), to_id.to_owned()),
            channel_label.to_owned(),
        );
        Ok(())
    }

    pub fn connect_duplex(
        &self,
        a_id: &str,
        b_id: &str,
        channel_label: &str,
    ) -> Result<(), AgentGraphError> {
        if a_id == b_id {
            return Err(AgentGraphError::SelfLink(a_id.to_owned()));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        if !guard.agents.contains_key(a_id) {
            return Err(AgentGraphError::UnknownAgent(a_id.to_owned()));
        }
        if !guard.agents.contains_key(b_id) {
            return Err(AgentGraphError::UnknownAgent(b_id.to_owned()));
        }
        guard
            .edges
            .insert((a_id.to_owned(), b_id.to_owned()), channel_label.to_owned());
        guard
            .edges
            .insert((b_id.to_owned(), a_id.to_owned()), channel_label.to_owned());
        Ok(())
    }

    /// Connect every distinct pair of listed agents in full bidirectional duplex (`A <-> B`).
    pub fn connect_all_to_all(
        &self,
        agent_ids: &[&str],
        channel_label: &str,
    ) -> Result<usize, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        for &id in agent_ids {
            if !guard.agents.contains_key(id) {
                return Err(AgentGraphError::UnknownAgent(id.to_owned()));
            }
        }
        let mut inserted = 0usize;
        for (i, &a) in agent_ids.iter().enumerate() {
            for &b in &agent_ids[i + 1..] {
                if a == b {
                    continue;
                }
                if guard
                    .edges
                    .insert((a.to_owned(), b.to_owned()), channel_label.to_owned())
                    .is_none()
                {
                    inserted += 1;
                }
                if guard
                    .edges
                    .insert((b.to_owned(), a.to_owned()), channel_label.to_owned())
                    .is_none()
                {
                    inserted += 1;
                }
            }
        }
        Ok(inserted)
    }

    pub fn has_duplex_link(&self, a_id: &str, b_id: &str) -> Result<bool, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard
            .edges
            .contains_key(&(a_id.to_owned(), b_id.to_owned()))
            && guard
                .edges
                .contains_key(&(b_id.to_owned(), a_id.to_owned())))
    }

    pub fn outgoing_peers(&self, id: &str) -> Result<Vec<String>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard
            .edges
            .keys()
            .filter(|(from, _)| from == id)
            .map(|(_, to)| to.clone())
            .collect())
    }

    pub fn incoming_peers(&self, id: &str) -> Result<Vec<String>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard
            .edges
            .keys()
            .filter(|(_, to)| to == id)
            .map(|(from, _)| from.clone())
            .collect())
    }

    pub fn duplex_peers(&self, id: &str) -> Result<Vec<String>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard
            .edges
            .keys()
            .filter(|(from, to)| {
                from == id && guard.edges.contains_key(&(to.clone(), id.to_owned()))
            })
            .map(|(_, to)| to.clone())
            .collect())
    }

    pub fn all_edges(&self) -> Result<Vec<PeerLinkEdge>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard
            .edges
            .iter()
            .map(|((from, to), label)| PeerLinkEdge {
                from_id: from.clone(),
                to_id: to.clone(),
                channel_label: label.clone(),
            })
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn send_peer(
        &self,
        from_id: &str,
        to_id: &str,
        topic: &str,
        payload: &str,
        epoch: Option<u64>,
        max_hops: Option<u32>,
        sent_at_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        validate_active_agent(&guard, from_id)?;
        validate_active_agent(&guard, to_id)?;
        if !guard
            .edges
            .contains_key(&(from_id.to_owned(), to_id.to_owned()))
        {
            return Err(AgentGraphError::UnlinkedPeers {
                from: from_id.to_owned(),
                to: to_id.to_owned(),
            });
        }
        let sender_epoch = guard.agents[from_id].epoch;
        let used_epoch = epoch.unwrap_or(sender_epoch);
        if used_epoch < sender_epoch {
            return Err(AgentGraphError::StaleEpoch {
                agent_id: from_id.to_owned(),
                current_epoch: sender_epoch,
                provided_epoch: used_epoch,
            });
        }
        let hops_cap = max_hops.unwrap_or(guard.default_max_hops).max(1);
        let seq = next_message_seq(&mut guard);
        let msg = PeerMessage {
            seq,
            from_id: from_id.to_owned(),
            recipients: vec![to_id.to_owned()],
            epoch: used_epoch,
            hop_count: 0,
            max_hops: hops_cap,
            in_reply_to_seq: None,
            topic: topic.to_owned(),
            payload: payload.to_owned(),
            sent_at_ms: sent_at_ms.unwrap_or_else(now_epoch_ms),
        };
        push_message_bounded(&mut guard, msg.clone());
        Ok(msg)
    }

    pub fn reply(
        &self,
        from_id: &str,
        in_reply_to_seq: u64,
        topic: &str,
        payload: &str,
        sent_at_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        validate_active_agent(&guard, from_id)?;
        if in_reply_to_seq == 0 {
            return Err(AgentGraphError::UnknownMessageSeq(0));
        }
        let orig = guard
            .messages
            .binary_search_by_key(&in_reply_to_seq, |m| m.seq)
            .ok()
            .and_then(|idx| guard.messages.get(idx))
            .cloned()
            .ok_or(AgentGraphError::UnknownMessageSeq(in_reply_to_seq))?;

        let target_id = &orig.from_id;
        validate_active_agent(&guard, target_id)?;
        if !orig.recipients.iter().any(|r| r == from_id) {
            return Err(AgentGraphError::UnauthorizedReply {
                from: from_id.to_owned(),
                seq: in_reply_to_seq,
            });
        }
        if !guard
            .edges
            .contains_key(&(from_id.to_owned(), target_id.clone()))
        {
            return Err(AgentGraphError::UnlinkedPeers {
                from: from_id.to_owned(),
                to: target_id.clone(),
            });
        }
        let next_hop = orig.hop_count.saturating_add(1);
        if next_hop >= orig.max_hops {
            return Err(AgentGraphError::HopBudgetExceeded {
                hop_count: next_hop,
                max_hops: orig.max_hops,
            });
        }
        let target_epoch = guard.agents[target_id].epoch;
        if target_epoch != orig.epoch {
            return Err(AgentGraphError::StaleEpoch {
                agent_id: target_id.clone(),
                current_epoch: target_epoch,
                provided_epoch: orig.epoch,
            });
        }
        let sender_epoch = guard.agents[from_id].epoch;

        let seq = next_message_seq(&mut guard);
        let msg = PeerMessage {
            seq,
            from_id: from_id.to_owned(),
            recipients: vec![target_id.clone()],
            epoch: sender_epoch,
            hop_count: next_hop,
            max_hops: orig.max_hops,
            in_reply_to_seq: Some(in_reply_to_seq),
            topic: if topic.is_empty() {
                orig.topic
            } else {
                topic.to_owned()
            },
            payload: payload.to_owned(),
            sent_at_ms: sent_at_ms.unwrap_or_else(now_epoch_ms),
        };
        push_message_bounded(&mut guard, msg.clone());
        Ok(msg)
    }

    pub fn broadcast(
        &self,
        from_id: &str,
        topic: &str,
        payload: &str,
        max_hops: Option<u32>,
        sent_at_ms: Option<i64>,
    ) -> Result<PeerMessage, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        validate_active_agent(&guard, from_id)?;
        let recipients: Vec<String> = guard
            .edges
            .keys()
            .filter(|(from, to)| {
                from == from_id && guard.agents.get(to).is_some_and(|node| node.active)
            })
            .map(|(_, to)| to.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let sender_epoch = guard.agents[from_id].epoch;
        let hops_cap = max_hops.unwrap_or(guard.default_max_hops).max(1);
        let seq = next_message_seq(&mut guard);
        let msg = PeerMessage {
            seq,
            from_id: from_id.to_owned(),
            recipients,
            epoch: sender_epoch,
            hop_count: 0,
            max_hops: hops_cap,
            in_reply_to_seq: None,
            topic: topic.to_owned(),
            payload: payload.to_owned(),
            sent_at_ms: sent_at_ms.unwrap_or_else(now_epoch_ms),
        };
        push_message_bounded(&mut guard, msg.clone());
        Ok(msg)
    }

    /// Cursor-based wakeup delivery: returns messages addressed to `agent_id` with `seq > since_seq`
    /// and advances `agent.last_read_seq` if unread messages were returned.
    pub fn read_since(
        &self,
        agent_id: &str,
        since_seq: u64,
    ) -> Result<Vec<PeerMessage>, AgentGraphError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        if !guard.agents.contains_key(agent_id) {
            return Err(AgentGraphError::UnknownAgent(agent_id.to_owned()));
        }
        let start_idx = guard.messages.partition_point(|msg| msg.seq <= since_seq);
        let mut delivered = Vec::new();
        let mut max_seen = since_seq;
        for msg in guard.messages.range(start_idx..) {
            if msg.recipients.iter().any(|r| r == agent_id) {
                max_seen = max_seen.max(msg.seq);
                delivered.push(msg.clone());
            }
        }
        if let Some(node) = guard.agents.get_mut(agent_id) {
            node.last_read_seq = node.last_read_seq.max(max_seen);
        }
        Ok(delivered)
    }

    pub fn drain_unread(&self, agent_id: &str) -> Result<Vec<PeerMessage>, AgentGraphError> {
        let since_seq = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
            guard
                .agents
                .get(agent_id)
                .map(|n| n.last_read_seq)
                .ok_or_else(|| AgentGraphError::UnknownAgent(agent_id.to_owned()))?
        };
        self.read_since(agent_id, since_seq)
    }

    pub fn all_messages(&self) -> Result<Vec<PeerMessage>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.messages.iter().cloned().collect())
    }

    pub fn detect_stalled_conversations(
        &self,
        now_ms: i64,
        stale_threshold_ms: i64,
    ) -> Result<Vec<StalledPeerAlert>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        let report = compute_convergence_locked(&guard, now_ms, stale_threshold_ms);
        Ok(report.stalled_agents)
    }

    pub fn convergence_status(
        &self,
        now_ms: i64,
        stale_threshold_ms: i64,
    ) -> Result<ConvergenceReport, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(compute_convergence_locked(
            &guard,
            now_ms,
            stale_threshold_ms,
        ))
    }
}

fn next_message_seq(guard: &mut MeshInner) -> u64 {
    let seq = guard.next_seq;
    guard.next_seq = guard.next_seq.saturating_add(1);
    seq
}

fn push_message_bounded(guard: &mut MeshInner, msg: PeerMessage) {
    let cap = guard.max_retained_messages.max(1);
    while guard.messages.len() >= cap {
        guard.messages.pop_front();
    }
    guard.messages.push_back(msg);
}

fn validate_active_agent(guard: &MeshInner, id: &str) -> Result<(), AgentGraphError> {
    let node = guard
        .agents
        .get(id)
        .ok_or_else(|| AgentGraphError::UnknownAgent(id.to_owned()))?;
    if !node.active {
        return Err(AgentGraphError::InactiveAgent(id.to_owned()));
    }
    Ok(())
}

fn compute_convergence_locked(
    guard: &MeshInner,
    now_ms: i64,
    stale_threshold_ms: i64,
) -> ConvergenceReport {
    let active_agents = guard.agents.values().filter(|a| a.active).count();
    let mut stalled = Vec::new();
    let mut pending_unread_deliveries = 0usize;

    for node in guard.agents.values() {
        if !node.active {
            continue;
        }
        let unread: Vec<&PeerMessage> = guard
            .messages
            .iter()
            .filter(|msg| {
                msg.seq > node.last_read_seq && msg.recipients.iter().any(|r| r == &node.id)
            })
            .collect();
        pending_unread_deliveries = pending_unread_deliveries.saturating_add(unread.len());
        if let Some(oldest) = unread.first() {
            let idle_for = now_ms.saturating_sub(oldest.sent_at_ms);
            if idle_for >= stale_threshold_ms {
                stalled.push(StalledPeerAlert {
                    agent_id: node.id.clone(),
                    unread_count: unread.len(),
                    oldest_unread_seq: oldest.seq,
                    oldest_unread_ms: oldest.sent_at_ms,
                    idle_for_ms: idle_for,
                });
            }
        }
    }

    ConvergenceReport {
        active_agents,
        total_messages: guard.messages.len(),
        pending_unread_deliveries,
        converged: pending_unread_deliveries == 0 && stalled.is_empty(),
        stalled_agents: stalled,
    }
}

#[cfg(test)]
mod aud26_path_tests {
    use super::*;

    #[test]
    fn normalize_repo_path_collapses_parent_segments_and_blocks_root_escape() {
        assert_eq!(normalize_repo_path("ui/../cpp/src/**"), "cpp/src");
        assert!(prefix_covers(
            &normalize_repo_path("cpp/src/**"),
            &normalize_repo_path("ui/../cpp/src/main.rs")
        ));
        assert_eq!(normalize_repo_path("../outside/secret.txt"), "");
        assert!(!prefix_covers("*", &normalize_repo_path("../outside")));
    }

    #[test]
    fn test_ownership_aliases_and_reactivation() {
        let mesh = PeerMeshGraph::new(6);
        for bad in [
            "../outside/**",
            "C:/cpp/src/**",
            "/etc/passwd",
            "cpp/src:ads",
            "cpp/**/src",
            "cpp/a*b",
            "cpp./src",
            "cpp/src?x",
        ] {
            let err = mesh
                .register_agent("bad-agent", AgentRole::Worker, vec![bad.into()], vec![])
                .unwrap_err();
            assert!(
                matches!(err, AgentGraphError::InvalidOwnedPath(_)),
                "expected InvalidOwnedPath for `{bad}`, got {err:?}"
            );
        }
        mesh.register_agent("a", AgentRole::Worker, vec!["rust/omnia-core/**".into()], vec![])
            .unwrap();
        let conflict = mesh
            .register_agent(
                "b",
                AgentRole::Worker,
                vec!["ui/../rust/omnia-core/src".into()],
                vec![],
            )
            .unwrap_err();
        assert!(matches!(conflict, AgentGraphError::OwnershipConflict { .. }));

        mesh.set_agent_active("a", false).unwrap();
        mesh.register_agent("b", AgentRole::Worker, vec!["rust/omnia-core/**".into()], vec![])
            .unwrap();
        let reactivate = mesh.set_agent_active("a", true).unwrap_err();
        assert!(matches!(reactivate, AgentGraphError::OwnershipConflict { .. }));
    }

    #[test]
    fn test_reply_authorization_and_epochs() {
        let mesh = PeerMeshGraph::new(6);
        mesh.register_agent("a", AgentRole::Worker, vec!["a/**".into()], vec![]).unwrap();
        mesh.register_agent("b", AgentRole::Worker, vec!["b/**".into()], vec![]).unwrap();
        mesh.register_agent("c", AgentRole::Worker, vec!["c/**".into()], vec![]).unwrap();
        mesh.connect_duplex("a", "b", "ab").unwrap();
        mesh.connect_duplex("a", "c", "ac").unwrap();

        let msg = mesh.send_peer("a", "b", "sync", "hello", None, None, Some(100)).unwrap();
        // Unauthorized third peer c cannot forge a reply to a -> b (zero message append).
        let unauth = mesh.reply("c", msg.seq, "", "spoof", Some(110)).unwrap_err();
        assert!(matches!(unauth, AgentGraphError::UnauthorizedReply { .. }));
        assert_eq!(mesh.all_messages().unwrap().len(), 1);

        // Authorized recipient b can reply, and broadcast recipients can reply.
        let valid_reply = mesh.reply("b", msg.seq, "", "ack", Some(112)).unwrap();
        assert_eq!(valid_reply.in_reply_to_seq, Some(msg.seq));
        let bcast = mesh.broadcast("a", "announce", "all hands", None, Some(115)).unwrap();
        assert!(mesh.reply("c", bcast.seq, "", "c-ack", Some(116)).is_ok());

        // Bumping original sender a's epoch must invalidate replies to a's pre-bump message.
        mesh.bump_agent_epoch("a").unwrap();
        let stale = mesh.reply("b", msg.seq, "", "late reply", Some(120)).unwrap_err();
        assert!(matches!(stale, AgentGraphError::StaleEpoch { .. }));
    }

    #[test]
    fn test_bounded_message_retention_preserves_seq_and_cursor() {
        let mesh = PeerMeshGraph::with_retention(6, 16);
        mesh.register_agent("a", AgentRole::Worker, vec!["a/**".into()], vec![]).unwrap();
        mesh.register_agent("b", AgentRole::Worker, vec!["b/**".into()], vec![]).unwrap();
        mesh.connect_duplex("a", "b", "ab").unwrap();

        for i in 1..=40_i64 {
            let m = mesh
                .send_peer("a", "b", "tick", &format!("msg-{i}"), None, None, Some(i * 10))
                .unwrap();
            assert_eq!(m.seq, i as u64);
        }

        let retained = mesh.all_messages().unwrap();
        assert_eq!(retained.len(), 16);
        assert_eq!(retained.first().unwrap().seq, 25);
        assert_eq!(retained.last().unwrap().seq, 40);

        let since_35 = mesh.read_since("b", 35).unwrap();
        assert_eq!(since_35.len(), 5);
        assert_eq!(since_35.first().unwrap().seq, 36);
        assert_eq!(since_35.last().unwrap().seq, 40);

        let r = mesh.reply("b", 40, "", "tail-reply", Some(500)).unwrap();
        assert_eq!(r.seq, 41);
        assert_eq!(mesh.all_messages().unwrap().len(), 16);

        let evicted = mesh.reply("b", 1, "", "too-old", Some(510)).unwrap_err();
        assert!(matches!(evicted, AgentGraphError::UnknownMessageSeq(1)));
    }
}
