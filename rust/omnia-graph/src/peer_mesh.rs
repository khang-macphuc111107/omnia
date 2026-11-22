use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use omnia_core::{now_epoch_ms, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

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

/// Normalize a repository-relative path for deterministic `disjoint_paths` comparison.
#[must_use]
pub fn normalize_repo_path(path: &str) -> String {
    let mut s = path
        .trim_matches([' ', '\t', '\r', '\n'])
        .replace('\\', "/");
    while let Some(rest) = s.strip_prefix("./") {
        s = rest.to_owned();
    }
    if s == "**" || s == "*" {
        return "*".to_owned();
    }
    loop {
        if let Some(rest) = s.strip_suffix("/**") {
            s = rest.to_owned();
        } else if let Some(rest) = s.strip_suffix("/*") {
            s = rest.to_owned();
        } else if s.len() > 1 && s.ends_with('/') {
            s.pop();
        } else {
            break;
        }
    }
    #[cfg(windows)]
    {
        s = s.to_ascii_lowercase();
    }
    s
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
    agents: BTreeMap<String, AgentNode>,
    edges: BTreeMap<(String, String), String>,
    messages: Vec<PeerMessage>,
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
        Self {
            inner: Mutex::new(MeshInner {
                default_max_hops: default_max_hops.max(1),
                agents: BTreeMap::new(),
                edges: BTreeMap::new(),
                messages: Vec::new(),
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
        let seq = u64::try_from(guard.messages.len().saturating_add(1)).unwrap_or(u64::MAX);
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
        guard.messages.push(msg.clone());
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
        let idx = usize::try_from(in_reply_to_seq - 1)
            .map_err(|_| AgentGraphError::UnknownMessageSeq(in_reply_to_seq))?;
        let orig = guard
            .messages
            .get(idx)
            .cloned()
            .ok_or(AgentGraphError::UnknownMessageSeq(in_reply_to_seq))?;

        let target_id = &orig.from_id;
        validate_active_agent(&guard, target_id)?;
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
        let sender_epoch = guard.agents[from_id].epoch;
        if orig.epoch < sender_epoch {
            return Err(AgentGraphError::StaleEpoch {
                agent_id: from_id.to_owned(),
                current_epoch: sender_epoch,
                provided_epoch: orig.epoch,
            });
        }

        let seq = u64::try_from(guard.messages.len().saturating_add(1)).unwrap_or(u64::MAX);
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
        guard.messages.push(msg.clone());
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
        let seq = u64::try_from(guard.messages.len().saturating_add(1)).unwrap_or(u64::MAX);
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
        guard.messages.push(msg.clone());
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
        let start_idx = usize::try_from(since_seq).unwrap_or(guard.messages.len());
        let mut delivered = Vec::new();
        let mut max_seen = since_seq;
        if start_idx < guard.messages.len() {
            for msg in &guard.messages[start_idx..] {
                if msg.recipients.iter().any(|r| r == agent_id) {
                    max_seen = max_seen.max(msg.seq);
                    delivered.push(msg.clone());
                }
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
        Ok(guard.messages.clone())
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
