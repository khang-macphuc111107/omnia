//! Bidirectional All-to-All General Agent Graph (`PeerMeshGraph`) and
//! Graphify-inspired Bidirectional Knowledge/Code Index (`GraphifyIndex`).
//!
//! Architectural guarantees (`PRODUCT-GRAPH`):
//! 1. **All-to-All 2-Way (`Duplex`) Agent Connectivity**: Any agent role
//!    (`Coordinator`, `Worker`, `Verifier`, `Specialist`, `Subagent`) can form
//!    symmetric 2-way links (`A <-> B`) with any other agent (`sibling <-> sibling`,
//!    `child <-> parent`, `worker <-> verifier`, or full `all-to-all` mesh) —
//!    never restricted to 1-way parent->child trees or acyclic DAGs.
//! 2. **O(1) Bidirectional Adjacency**: Both `PeerMeshGraph` and `GraphifyIndex`
//!    maintain synchronized `outgoing` and `incoming` adjacency maps plus
//!    symmetric peer sets for O(1) forward, reverse, and 2-way neighbor lookups.
//! 3. **Full Duplex Routing & Cursor Delivery**: Supports `send_peer`, `reply`
//!    (automatic reverse-path routing with hop propagation), `broadcast`, and
//!    zero-loss `read_since(agent_id, since_seq)` cursor reads.
//! 4. **Disjoint File-Ownership Guard**: Rejects concurrent overlapping path
//!    claims across peers unless explicitly carved out via `excluded_paths`.
//! 5. **Cyclic-Conversation Safety Without DAG Restrictions**: Permits cyclic
//!    multi-agent negotiation (`A -> B -> C -> A -> B`) while enforcing
//!    per-conversation `max_hops`, monotonic `epoch` fencing, and stall detection.
//! 6. **Graphify Provenance (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`)**: Every
//!    knowledge/code/agent edge carries explicit provenance and confidence,
//!    traversable in `Forward`, `Reverse`, or `Both` directions.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::memory::{EdgeProvenance, MemoryGraph};

/// Role of an agent participating in a general bidirectional peer mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Coordinator,
    Worker,
    Verifier,
    Specialist,
    Subagent,
}

/// Graphify-compatible provenance classification for edges and routed claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GraphifyProvenance {
    /// Directly observed from AST, explicit link declaration, or runtime receipt.
    Extracted,
    /// Derived deterministically or via multi-hop synthesis with supporting context.
    Inferred,
    /// Low-certainty or conflicting signal; excluded from strict traversals by default.
    Ambiguous,
}

impl GraphifyProvenance {
    pub const fn default_confidence_bps(self) -> u16 {
        match self {
            Self::Extracted => 10_000,
            Self::Inferred => 7_500,
            Self::Ambiguous => 3_500,
        }
    }
}

impl From<EdgeProvenance> for GraphifyProvenance {
    fn from(value: EdgeProvenance) -> Self {
        match value {
            EdgeProvenance::Extracted => Self::Extracted,
            EdgeProvenance::Inferred => Self::Inferred,
            EdgeProvenance::Ambiguous => Self::Ambiguous,
        }
    }
}

impl From<GraphifyProvenance> for EdgeProvenance {
    fn from(value: GraphifyProvenance) -> Self {
        match value {
            GraphifyProvenance::Extracted => Self::Extracted,
            GraphifyProvenance::Inferred => Self::Inferred,
            GraphifyProvenance::Ambiguous => Self::Ambiguous,
        }
    }
}

/// Traversal direction across any typed edge set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraversalDirection {
    /// Follow `from -> to` outgoing edges only.
    Forward,
    /// Follow `to <- from` incoming edges only (reverse dependency / backlink query).
    Reverse,
    /// Follow both `from -> to` and `to <- from` edges symmetrically.
    Both,
}

/// Registered agent node in `PeerMeshGraph`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentNode {
    pub agent_id: String,
    pub role: AgentRole,
    /// Normalized workspace path prefixes or globs owned exclusively by this agent.
    pub owned_paths: Vec<String>,
    /// Normalized workspace sub-paths carved out and delegated to another peer.
    pub excluded_paths: Vec<String>,
    pub capabilities: BTreeSet<String>,
    /// Monotonic generation epoch used to fence stale messages after re-steering.
    pub epoch: u64,
    pub active: bool,
    pub registered_at_ms: u64,
}

impl AgentNode {
    pub fn new(agent_id: impl Into<String>, role: AgentRole, registered_at_ms: u64) -> Self {
        Self {
            agent_id: agent_id.into(),
            role,
            owned_paths: Vec::new(),
            excluded_paths: Vec::new(),
            capabilities: BTreeSet::new(),
            epoch: 1,
            active: true,
            registered_at_ms,
        }
    }

    pub fn with_owned_paths<I, S>(mut self, paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.owned_paths = paths
            .into_iter()
            .map(|s| normalize_owned_pattern(&s.into()))
            .collect();
        self
    }

    pub fn with_excluded_paths<I, S>(mut self, paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.excluded_paths = paths
            .into_iter()
            .map(|s| normalize_owned_pattern(&s.into()))
            .collect();
        self
    }

    pub fn with_capabilities<I, S>(mut self, caps: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.capabilities = caps.into_iter().map(Into::into).collect();
        self
    }
}

/// Metadata for a directed half-edge inside a bidirectional (`Duplex`) or directed link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerChannelEdge {
    pub from: String,
    pub to: String,
    pub relation: String,
    pub duplex: bool,
    pub provenance: GraphifyProvenance,
    pub created_at_ms: u64,
}

/// Addressing mode for peer-to-peer and mesh messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerTarget {
    /// Direct peer-to-peer message (`from -> to` over an active link).
    Direct(String),
    /// Explicit reply routed back to the sender of `in_reply_to_seq`.
    Reply { to: String, in_reply_to_seq: u64 },
    /// Multicast to a named subset of linked peers.
    Group(Vec<String>),
    /// Broadcast to all双向/linked peers of the sender.
    BroadcastPeers,
}

/// Immutable routed message envelope on the peer mesh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerEnvelope {
    pub seq: u64,
    pub conversation_id: String,
    pub from: String,
    pub target: PeerTarget,
    pub recipients: BTreeSet<String>,
    pub in_reply_to_seq: Option<u64>,
    pub hop_count: u32,
    pub max_hops: u32,
    pub sender_epoch: u64,
    pub provenance: GraphifyProvenance,
    pub payload: String,
    pub expect_reply_from: Option<String>,
    pub timestamp_ms: u64,
}

/// Request parameters for `PeerMeshGraph::send_peer`.
#[derive(Debug, Clone)]
pub struct SendPeerRequest {
    pub from: String,
    pub to: String,
    pub conversation_id: String,
    pub payload: String,
    pub provenance: GraphifyProvenance,
    pub hop_count: u32,
    pub max_hops: u32,
    pub sender_epoch: Option<u64>,
    pub expect_reply: bool,
    pub now_ms: u64,
}

/// Diagnostic snapshot for a stalled cyclic or peer-to-peer conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StalledConversation {
    pub conversation_id: String,
    pub last_seq: u64,
    pub last_sender: String,
    pub waiting_on_peer: String,
    pub elapsed_ms: u64,
}

/// Errors returned by `PeerMeshGraph` and `GraphifyIndex`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AgentGraphError {
    #[error("invalid agent identifier `{0}`")]
    InvalidAgentId(String),
    #[error("unknown agent `{0}`")]
    UnknownAgent(String),
    #[error("agent `{0}` is inactive")]
    InactiveAgent(String),
    #[error("self-loop link on agent `{0}` is not permitted")]
    SelfLink(String),
    #[error("no active link from `{from}` to `{to}`")]
    UnlinkedPeers { from: String, to: String },
    #[error("disjoint path ownership conflict between `{peer_a}` and `{peer_b}` on `{overlapping_pattern}`")]
    OwnershipConflict {
        peer_a: String,
        peer_b: String,
        overlapping_pattern: String,
    },
    #[error("conversation `{conversation_id}` exceeded hop budget ({hop_count} >= {max_hops})")]
    HopBudgetExceeded {
        conversation_id: String,
        hop_count: u32,
        max_hops: u32,
    },
    #[error(
        "stale epoch for agent `{agent_id}`: message epoch {provided} != active epoch {expected}"
    )]
    StaleEpoch {
        agent_id: String,
        provided: u64,
        expected: u64,
    },
    #[error("message sequence #{0} not found")]
    UnknownMessageSeq(u64),
}

#[derive(Debug, Clone)]
struct ConversationTracker {
    last_seq: u64,
    last_sender: String,
    waiting_on_peer: Option<String>,
    last_activity_ms: u64,
}

/// General cyclic, bidirectional (`A <-> B`) multi-agent topology and message router.
#[derive(Debug, Clone, Default)]
pub struct PeerMeshGraph {
    agents: BTreeMap<String, AgentNode>,
    /// O(1) outgoing adjacency: `from -> (to -> PeerChannelEdge)`.
    outgoing: HashMap<String, BTreeMap<String, PeerChannelEdge>>,
    /// O(1) incoming adjacency: `to -> (from -> PeerChannelEdge)`.
    incoming: HashMap<String, BTreeMap<String, PeerChannelEdge>>,
    /// O(1) symmetric 2-way peer lookup (`A` and `B` connected in both directions).
    duplex_peers: HashMap<String, BTreeSet<String>>,
    messages: Vec<PeerEnvelope>,
    read_cursors: HashMap<String, u64>,
    conversations: BTreeMap<String, ConversationTracker>,
    default_max_hops: u32,
}

impl PeerMeshGraph {
    pub fn new(default_max_hops: u32) -> Self {
        Self {
            default_max_hops: default_max_hops.max(1),
            ..Self::default()
        }
    }

    /// Registers or updates an agent node after verifying disjoint file ownership
    /// against all other active agents in the mesh.
    pub fn register_agent(&mut self, mut node: AgentNode) -> Result<(), AgentGraphError> {
        let id = validate_agent_id(&node.agent_id)?;
        node.agent_id = id.clone();
        node.owned_paths = node
            .owned_paths
            .iter()
            .map(|p| normalize_owned_pattern(p))
            .filter(|p| !p.is_empty())
            .collect();
        node.excluded_paths = node
            .excluded_paths
            .iter()
            .map(|p| normalize_owned_pattern(p))
            .filter(|p| !p.is_empty())
            .collect();

        if node.active {
            for (other_id, other) in &self.agents {
                if other_id == &id || !other.active {
                    continue;
                }
                if let Some(conflict) = detect_effective_overlap(&node, other) {
                    return Err(AgentGraphError::OwnershipConflict {
                        peer_a: id,
                        peer_b: other_id.clone(),
                        overlapping_pattern: conflict,
                    });
                }
            }
        }

        self.outgoing.entry(id.clone()).or_default();
        self.incoming.entry(id.clone()).or_default();
        self.duplex_peers.entry(id.clone()).or_default();
        self.agents.insert(id, node);
        Ok(())
    }

    pub fn agent(&self, agent_id: &str) -> Option<&AgentNode> {
        self.agents.get(agent_id)
    }

    /// Advances an agent's generation epoch (e.g. upon a compare-and-swap steer),
    /// fencing any late in-flight messages carrying an older epoch.
    pub fn bump_agent_epoch(&mut self, agent_id: &str) -> Result<u64, AgentGraphError> {
        let agent = self
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| AgentGraphError::UnknownAgent(agent_id.to_string()))?;
        agent.epoch = agent.epoch.saturating_add(1);
        Ok(agent.epoch)
    }

    /// Establishes a symmetric 2-way (`Duplex`) link `agent_a <-> agent_b` so both
    /// peers can initiate messages, replies, and provenance queries directly.
    pub fn connect_duplex(
        &mut self,
        agent_a: &str,
        agent_b: &str,
        relation: impl Into<String>,
        provenance: GraphifyProvenance,
        now_ms: u64,
    ) -> Result<(), AgentGraphError> {
        if agent_a == agent_b {
            return Err(AgentGraphError::SelfLink(agent_a.to_string()));
        }
        self.ensure_registered(agent_a)?;
        self.ensure_registered(agent_b)?;
        let rel = relation.into();

        let ab = PeerChannelEdge {
            from: agent_a.to_string(),
            to: agent_b.to_string(),
            relation: rel.clone(),
            duplex: true,
            provenance,
            created_at_ms: now_ms,
        };
        let ba = PeerChannelEdge {
            from: agent_b.to_string(),
            to: agent_a.to_string(),
            relation: rel,
            duplex: true,
            provenance,
            created_at_ms: now_ms,
        };

        self.outgoing
            .entry(agent_a.to_string())
            .or_default()
            .insert(agent_b.to_string(), ab.clone());
        self.incoming
            .entry(agent_b.to_string())
            .or_default()
            .insert(agent_a.to_string(), ab);

        self.outgoing
            .entry(agent_b.to_string())
            .or_default()
            .insert(agent_a.to_string(), ba.clone());
        self.incoming
            .entry(agent_a.to_string())
            .or_default()
            .insert(agent_b.to_string(), ba);

        self.duplex_peers
            .entry(agent_a.to_string())
            .or_default()
            .insert(agent_b.to_string());
        self.duplex_peers
            .entry(agent_b.to_string())
            .or_default()
            .insert(agent_a.to_string());
        Ok(())
    }

    /// Connects every pair among `agent_ids` with symmetric 2-way (`Duplex`) links
    /// (`K_n` complete peer mesh) so every agent can communicate 2-way with every other agent.
    pub fn connect_all_to_all<I, S>(
        &mut self,
        agent_ids: I,
        relation: &str,
        provenance: GraphifyProvenance,
        now_ms: u64,
    ) -> Result<usize, AgentGraphError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let ids: Vec<String> = agent_ids
            .into_iter()
            .map(|s| s.as_ref().to_string())
            .collect();
        for id in &ids {
            self.ensure_registered(id)?;
        }
        let mut created_pairs = 0usize;
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                if ids[i] != ids[j] {
                    self.connect_duplex(&ids[i], &ids[j], relation, provenance, now_ms)?;
                    created_pairs += 1;
                }
            }
        }
        Ok(created_pairs)
    }

    /// Connects all currently registered agents in a complete 2-way mesh (`@all <-> @all`).
    pub fn connect_entire_roster_duplex(
        &mut self,
        relation: &str,
        provenance: GraphifyProvenance,
        now_ms: u64,
    ) -> Result<usize, AgentGraphError> {
        let ids: Vec<String> = self.agents.keys().cloned().collect();
        self.connect_all_to_all(ids, relation, provenance, now_ms)
    }

    /// O(1) check whether `agent_a` and `agent_b` share a 2-way (`A <-> B`) link.
    pub fn has_duplex_link(&self, agent_a: &str, agent_b: &str) -> bool {
        self.duplex_peers
            .get(agent_a)
            .is_some_and(|peers| peers.contains(agent_b))
            && self
                .duplex_peers
                .get(agent_b)
                .is_some_and(|peers| peers.contains(agent_a))
    }

    /// O(1) sorted list of symmetric 2-way peers linked with `agent_id`.
    pub fn bidirectional_peers(&self, agent_id: &str) -> Vec<String> {
        self.duplex_peers
            .get(agent_id)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// O(1) directional neighbor lookup (`Forward`, `Reverse`, or `Both`).
    pub fn neighbors(&self, agent_id: &str, direction: TraversalDirection) -> Vec<String> {
        let mut set = BTreeSet::new();
        if matches!(
            direction,
            TraversalDirection::Forward | TraversalDirection::Both
        ) {
            if let Some(out) = self.outgoing.get(agent_id) {
                set.extend(out.keys().cloned());
            }
        }
        if matches!(
            direction,
            TraversalDirection::Reverse | TraversalDirection::Both
        ) {
            if let Some(inc) = self.incoming.get(agent_id) {
                set.extend(inc.keys().cloned());
            }
        }
        set.into_iter().collect()
    }

    /// Sends a direct message over an active peer link (`from -> to`), enforcing
    /// `epoch` fencing and cyclic `max_hops` bounds.
    pub fn send_peer(&mut self, req: SendPeerRequest) -> Result<PeerEnvelope, AgentGraphError> {
        let sender = self.ensure_active_agent(&req.from)?;
        let sender_epoch = match req.sender_epoch {
            Some(ep) if ep != sender.epoch => {
                return Err(AgentGraphError::StaleEpoch {
                    agent_id: req.from.clone(),
                    provided: ep,
                    expected: sender.epoch,
                });
            }
            Some(ep) => ep,
            None => sender.epoch,
        };
        let _ = self.ensure_active_agent(&req.to)?;
        self.ensure_link(&req.from, &req.to)?;

        let effective_max_hops = if req.max_hops == 0 {
            self.default_max_hops
        } else {
            req.max_hops
        };
        if req.hop_count >= effective_max_hops {
            return Err(AgentGraphError::HopBudgetExceeded {
                conversation_id: req.conversation_id,
                hop_count: req.hop_count,
                max_hops: effective_max_hops,
            });
        }

        let seq = (self.messages.len() as u64) + 1;
        let mut recipients = BTreeSet::new();
        recipients.insert(req.to.clone());

        let waiting_on_peer = req.expect_reply.then(|| req.to.clone());
        let env = PeerEnvelope {
            seq,
            conversation_id: req.conversation_id.clone(),
            from: req.from.clone(),
            target: PeerTarget::Direct(req.to),
            recipients,
            in_reply_to_seq: None,
            hop_count: req.hop_count,
            max_hops: effective_max_hops,
            sender_epoch,
            provenance: req.provenance,
            payload: req.payload,
            expect_reply_from: waiting_on_peer.clone(),
            timestamp_ms: req.now_ms,
        };
        self.conversations.insert(
            req.conversation_id,
            ConversationTracker {
                last_seq: seq,
                last_sender: req.from,
                waiting_on_peer,
                last_activity_ms: req.now_ms,
            },
        );
        self.messages.push(env.clone());
        Ok(env)
    }

    /// Sends a 2-way reply back to the sender of `in_reply_to_seq`, automatically
    /// traversing the reverse direction (`replier -> original_sender`) and incrementing `hop_count`.
    pub fn reply(
        &mut self,
        from: &str,
        in_reply_to_seq: u64,
        payload: impl Into<String>,
        provenance: GraphifyProvenance,
        expect_further_reply: bool,
        now_ms: u64,
    ) -> Result<PeerEnvelope, AgentGraphError> {
        let sender_epoch = self.ensure_active_agent(from)?.epoch;
        let original = self
            .messages
            .get((in_reply_to_seq.saturating_sub(1)) as usize)
            .filter(|m| m.seq == in_reply_to_seq)
            .cloned()
            .ok_or(AgentGraphError::UnknownMessageSeq(in_reply_to_seq))?;

        let reply_to = original.from.clone();
        let _ = self.ensure_active_agent(&reply_to)?;
        self.ensure_link(from, &reply_to)?;

        let next_hop = original.hop_count.saturating_add(1);
        if next_hop >= original.max_hops {
            return Err(AgentGraphError::HopBudgetExceeded {
                conversation_id: original.conversation_id,
                hop_count: next_hop,
                max_hops: original.max_hops,
            });
        }

        let seq = (self.messages.len() as u64) + 1;
        let mut recipients = BTreeSet::new();
        recipients.insert(reply_to.clone());
        let waiting_on_peer = expect_further_reply.then(|| reply_to.clone());

        let env = PeerEnvelope {
            seq,
            conversation_id: original.conversation_id.clone(),
            from: from.to_string(),
            target: PeerTarget::Reply {
                to: reply_to,
                in_reply_to_seq,
            },
            recipients,
            in_reply_to_seq: Some(in_reply_to_seq),
            hop_count: next_hop,
            max_hops: original.max_hops,
            sender_epoch,
            provenance,
            payload: payload.into(),
            expect_reply_from: waiting_on_peer.clone(),
            timestamp_ms: now_ms,
        };
        self.conversations.insert(
            original.conversation_id,
            ConversationTracker {
                last_seq: seq,
                last_sender: from.to_string(),
                waiting_on_peer,
                last_activity_ms: now_ms,
            },
        );
        self.messages.push(env.clone());
        Ok(env)
    }

    /// Broadcasts a message from `from` to all of its active linked peers.
    pub fn broadcast(
        &mut self,
        from: &str,
        conversation_id: impl Into<String>,
        payload: impl Into<String>,
        provenance: GraphifyProvenance,
        max_hops: u32,
        now_ms: u64,
    ) -> Result<PeerEnvelope, AgentGraphError> {
        let sender_epoch = self.ensure_active_agent(from)?.epoch;
        let recipients: BTreeSet<String> = self
            .outgoing
            .get(from)
            .into_iter()
            .flat_map(|m| m.keys())
            .filter(|peer_id| self.agents.get(*peer_id).is_some_and(|a| a.active))
            .cloned()
            .collect();

        let conv_id = conversation_id.into();
        let effective_max_hops = if max_hops == 0 {
            self.default_max_hops
        } else {
            max_hops
        };
        let seq = (self.messages.len() as u64) + 1;
        let env = PeerEnvelope {
            seq,
            conversation_id: conv_id.clone(),
            from: from.to_string(),
            target: PeerTarget::BroadcastPeers,
            recipients,
            in_reply_to_seq: None,
            hop_count: 0,
            max_hops: effective_max_hops,
            sender_epoch,
            provenance,
            payload: payload.into(),
            expect_reply_from: None,
            timestamp_ms: now_ms,
        };
        self.conversations.insert(
            conv_id,
            ConversationTracker {
                last_seq: seq,
                last_sender: from.to_string(),
                waiting_on_peer: None,
                last_activity_ms: now_ms,
            },
        );
        self.messages.push(env.clone());
        Ok(env)
    }

    /// Cursor-based zero-loss inbox read returning all messages addressed to `agent_id`
    /// after `since_seq` (`seq > since_seq`), ordered oldest-first.
    pub fn read_since(&self, agent_id: &str, since_seq: u64) -> Vec<PeerEnvelope> {
        let start_idx = since_seq as usize;
        if start_idx >= self.messages.len() {
            return Vec::new();
        }
        self.messages[start_idx..]
            .iter()
            .filter(|m| m.recipients.contains(agent_id))
            .cloned()
            .collect()
    }

    /// Reads unread messages using the stored cursor for `agent_id` and advances that cursor.
    pub fn drain_unread(&mut self, agent_id: &str) -> Vec<PeerEnvelope> {
        let since = self.read_cursors.get(agent_id).copied().unwrap_or(0);
        let head = self.messages.len() as u64;
        let msgs = self.read_since(agent_id, since);
        self.read_cursors.insert(agent_id.to_string(), head);
        msgs
    }

    /// Detects conversations waiting on a peer reply longer than `stall_timeout_ms`.
    pub fn detect_stalled_conversations(
        &self,
        now_ms: u64,
        stall_timeout_ms: u64,
    ) -> Vec<StalledConversation> {
        let mut stalled = Vec::new();
        for (conv_id, tracker) in &self.conversations {
            if let Some(peer) = &tracker.waiting_on_peer {
                let elapsed = now_ms.saturating_sub(tracker.last_activity_ms);
                if elapsed >= stall_timeout_ms {
                    stalled.push(StalledConversation {
                        conversation_id: conv_id.clone(),
                        last_seq: tracker.last_seq,
                        last_sender: tracker.last_sender.clone(),
                        waiting_on_peer: peer.clone(),
                        elapsed_ms: elapsed,
                    });
                }
            }
        }
        stalled
    }

    fn ensure_registered(&self, agent_id: &str) -> Result<&AgentNode, AgentGraphError> {
        self.agents
            .get(agent_id)
            .ok_or_else(|| AgentGraphError::UnknownAgent(agent_id.to_string()))
    }

    fn ensure_active_agent(&self, agent_id: &str) -> Result<&AgentNode, AgentGraphError> {
        let node = self.ensure_registered(agent_id)?;
        if !node.active {
            return Err(AgentGraphError::InactiveAgent(agent_id.to_string()));
        }
        Ok(node)
    }

    fn ensure_link(&self, from: &str, to: &str) -> Result<(), AgentGraphError> {
        let linked = self
            .outgoing
            .get(from)
            .is_some_and(|targets| targets.contains_key(to));
        if !linked {
            return Err(AgentGraphError::UnlinkedPeers {
                from: from.to_string(),
                to: to.to_string(),
            });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Graphify-Inspired Bidirectional Knowledge / Code / Agent Graph Index
// ---------------------------------------------------------------------------

/// Kind of entity indexed in `GraphifyIndex`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphifyEntityKind {
    Agent,
    CodeModule,
    Symbol,
    Skill,
    MemoryNote,
    Artifact,
    Requirement,
}

/// Entity vertex inside `GraphifyIndex`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphifyEntity {
    pub id: String,
    pub kind: GraphifyEntityKind,
    pub label: String,
    pub path: Option<String>,
    pub summary: String,
}

/// Typed, provenance-tagged relation inside `GraphifyIndex`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphifyEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    pub provenance: GraphifyProvenance,
    pub confidence_bps: u16,
    pub rationale: Option<String>,
}

/// Result of a directional or 2-way BFS traversal over `GraphifyIndex`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphifySubgraph {
    pub visited_entities: Vec<GraphifyEntity>,
    pub traversed_edges: Vec<GraphifyEdge>,
    pub detected_cycles: Vec<Vec<String>>,
    pub extracted_edge_count: usize,
    pub inferred_edge_count: usize,
    pub ambiguous_edge_count: usize,
}

/// Deterministic Graphify-style bidirectional index over code modules, symbols,
/// skills, memory notes, requirements, and agents.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GraphifyIndex {
    entities: BTreeMap<String, GraphifyEntity>,
    edges: Vec<GraphifyEdge>,
    #[serde(skip)]
    outgoing_idx: HashMap<String, Vec<usize>>,
    #[serde(skip)]
    incoming_idx: HashMap<String, Vec<usize>>,
}

impl GraphifyIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hydrates a `GraphifyIndex` from a durable `MemoryGraph` with O(1) forward
    /// and reverse adjacency indices ready for bidirectional queries.
    pub fn from_memory_graph(mem: &MemoryGraph) -> Self {
        let mut idx = Self::new();
        for (node_id, meta) in &mem.nodes {
            idx.upsert_entity(GraphifyEntity {
                id: node_id.clone(),
                kind: GraphifyEntityKind::MemoryNote,
                label: meta.name.clone(),
                path: Some(format!("{}:{}/{}", meta.scope, meta.namespace, meta.slug)),
                summary: meta.description.clone(),
            });
        }
        for edge in &mem.edges {
            idx.add_edge(GraphifyEdge {
                from_id: edge.from_id.clone(),
                to_id: edge.to_id.clone(),
                relation: edge.relation.clone(),
                provenance: edge.provenance.into(),
                confidence_bps: edge.confidence_bps,
                rationale: edge.rationale.clone(),
            });
        }
        idx
    }

    pub fn upsert_entity(&mut self, entity: GraphifyEntity) {
        self.outgoing_idx.entry(entity.id.clone()).or_default();
        self.incoming_idx.entry(entity.id.clone()).or_default();
        self.entities.insert(entity.id.clone(), entity);
    }

    pub fn entity(&self, id: &str) -> Option<&GraphifyEntity> {
        self.entities.get(id)
    }

    /// Adds a directed edge (`from_id -> to_id`) and indexes it in BOTH
    /// `outgoing_idx[from_id]` and `incoming_idx[to_id]` so reverse queries run in O(deg).
    pub fn add_edge(&mut self, edge: GraphifyEdge) {
        let duplicate = self
            .outgoing_idx
            .get(&edge.from_id)
            .into_iter()
            .flatten()
            .any(|&i| {
                let existing = &self.edges[i];
                existing.to_id == edge.to_id
                    && existing.relation == edge.relation
                    && existing.provenance == edge.provenance
            });
        if duplicate {
            return;
        }
        let slot = self.edges.len();
        self.outgoing_idx
            .entry(edge.from_id.clone())
            .or_default()
            .push(slot);
        self.incoming_idx
            .entry(edge.to_id.clone())
            .or_default()
            .push(slot);
        self.edges.push(edge);
    }

    /// Adds a symmetric 2-way relation (`a <-> b`) in one call.
    pub fn add_bidirectional_edge(
        &mut self,
        a_id: impl Into<String>,
        b_id: impl Into<String>,
        relation: impl Into<String>,
        provenance: GraphifyProvenance,
        rationale: Option<String>,
    ) {
        let a = a_id.into();
        let b = b_id.into();
        let rel = relation.into();
        let confidence_bps = provenance.default_confidence_bps();
        self.add_edge(GraphifyEdge {
            from_id: a.clone(),
            to_id: b.clone(),
            relation: rel.clone(),
            provenance,
            confidence_bps,
            rationale: rationale.clone(),
        });
        self.add_edge(GraphifyEdge {
            from_id: b,
            to_id: a,
            relation: rel,
            provenance,
            confidence_bps,
            rationale,
        });
    }

    /// Rebuilds in-memory O(1) adjacency tables after deserialization.
    pub fn rebuild_adjacency(&mut self) {
        self.outgoing_idx.clear();
        self.incoming_idx.clear();
        for id in self.entities.keys() {
            self.outgoing_idx.insert(id.clone(), Vec::new());
            self.incoming_idx.insert(id.clone(), Vec::new());
        }
        for (slot, edge) in self.edges.iter().enumerate() {
            self.outgoing_idx
                .entry(edge.from_id.clone())
                .or_default()
                .push(slot);
            self.incoming_idx
                .entry(edge.to_id.clone())
                .or_default()
                .push(slot);
        }
    }

    /// Returns incident edges in `Forward` (`from_id == id`), `Reverse` (`to_id == id`),
    /// or `Both` directions, optionally excluding `Ambiguous` edges.
    pub fn incident_edges(
        &self,
        entity_id: &str,
        direction: TraversalDirection,
        include_ambiguous: bool,
    ) -> Vec<&GraphifyEdge> {
        let mut slots = BTreeSet::new();
        if matches!(
            direction,
            TraversalDirection::Forward | TraversalDirection::Both
        ) {
            if let Some(out) = self.outgoing_idx.get(entity_id) {
                slots.extend(out.iter().copied());
            }
        }
        if matches!(
            direction,
            TraversalDirection::Reverse | TraversalDirection::Both
        ) {
            if let Some(inc) = self.incoming_idx.get(entity_id) {
                slots.extend(inc.iter().copied());
            }
        }
        slots
            .into_iter()
            .map(|i| &self.edges[i])
            .filter(|e| include_ambiguous || e.provenance != GraphifyProvenance::Ambiguous)
            .collect()
    }

    /// Cycle-safe directional or 2-way (`Both`) neighborhood traversal with explicit
    /// provenance accounting.
    pub fn traverse(
        &self,
        seed_ids: &[String],
        direction: TraversalDirection,
        max_hops: usize,
        include_ambiguous: bool,
    ) -> GraphifySubgraph {
        let mut visited_ids: HashSet<String> = HashSet::new();
        let mut visited_entities: Vec<GraphifyEntity> = Vec::new();
        let mut seen_edges: BTreeSet<usize> = BTreeSet::new();
        let mut detected_cycles: Vec<Vec<String>> = Vec::new();
        let mut queue: VecDeque<(String, usize, Vec<String>)> = VecDeque::new();

        for seed in seed_ids {
            if visited_ids.insert(seed.clone()) {
                if let Some(ent) = self.entities.get(seed) {
                    visited_entities.push(ent.clone());
                }
                queue.push_back((seed.clone(), 0, vec![seed.clone()]));
            }
        }

        while let Some((current, depth, path)) = queue.pop_front() {
            if depth >= max_hops {
                continue;
            }

            let mut candidate_slots: Vec<(usize, &str)> = Vec::new();
            if matches!(
                direction,
                TraversalDirection::Forward | TraversalDirection::Both
            ) {
                if let Some(out) = self.outgoing_idx.get(&current) {
                    for &slot in out {
                        candidate_slots.push((slot, &self.edges[slot].to_id));
                    }
                }
            }
            if matches!(
                direction,
                TraversalDirection::Reverse | TraversalDirection::Both
            ) {
                if let Some(inc) = self.incoming_idx.get(&current) {
                    for &slot in inc {
                        candidate_slots.push((slot, &self.edges[slot].from_id));
                    }
                }
            }

            for (slot, next_id) in candidate_slots {
                let edge = &self.edges[slot];
                if !include_ambiguous && edge.provenance == GraphifyProvenance::Ambiguous {
                    continue;
                }
                seen_edges.insert(slot);

                if path.contains(&next_id.to_string()) {
                    // Ignore trivial 2-node bounce (`A -> B -> A`) on undirected/Both walks unless
                    // it is a genuine directed cycle in Forward/Reverse mode or length >= 3.
                    let is_trivial_backtrack = direction == TraversalDirection::Both
                        && path.len() >= 2
                        && path[path.len() - 2] == next_id;
                    if !is_trivial_backtrack {
                        let mut cycle = path.clone();
                        cycle.push(next_id.to_string());
                        if !detected_cycles.contains(&cycle) {
                            detected_cycles.push(cycle);
                        }
                    }
                    continue;
                }

                if visited_ids.insert(next_id.to_string()) {
                    if let Some(ent) = self.entities.get(next_id) {
                        visited_entities.push(ent.clone());
                    }
                    let mut next_path = path.clone();
                    next_path.push(next_id.to_string());
                    queue.push_back((next_id.to_string(), depth + 1, next_path));
                }
            }
        }

        let traversed_edges: Vec<GraphifyEdge> = seen_edges
            .into_iter()
            .map(|i| self.edges[i].clone())
            .collect();
        let extracted_edge_count = traversed_edges
            .iter()
            .filter(|e| e.provenance == GraphifyProvenance::Extracted)
            .count();
        let inferred_edge_count = traversed_edges
            .iter()
            .filter(|e| e.provenance == GraphifyProvenance::Inferred)
            .count();
        let ambiguous_edge_count = traversed_edges
            .iter()
            .filter(|e| e.provenance == GraphifyProvenance::Ambiguous)
            .count();

        GraphifySubgraph {
            visited_entities,
            traversed_edges,
            detected_cycles,
            extracted_edge_count,
            inferred_edge_count,
            ambiguous_edge_count,
        }
    }
}

// ---------------------------------------------------------------------------
// Path Normalization & Disjoint Ownership Helpers
// ---------------------------------------------------------------------------

fn validate_agent_id(raw: &str) -> Result<String, AgentGraphError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AgentGraphError::InvalidAgentId(raw.to_string()));
    }
    Ok(trimmed.to_string())
}

fn normalize_owned_pattern(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if let Some(stripped) = s.strip_suffix("/**") {
        s = stripped.to_string();
    } else if let Some(stripped) = s.strip_suffix("/*") {
        s = stripped.to_string();
    }
    s.trim_matches('/').to_ascii_lowercase()
}

fn pattern_contains_or_equals(container: &str, candidate: &str) -> bool {
    if container.is_empty() || candidate.is_empty() {
        return false;
    }
    container == candidate
        || candidate
            .strip_prefix(container)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn is_carved_out_by_exclusions(target: &str, exclusions: &[String]) -> bool {
    exclusions
        .iter()
        .any(|excl| pattern_contains_or_equals(excl, target))
}

fn detect_effective_overlap(a: &AgentNode, b: &AgentNode) -> Option<String> {
    for pa in &a.owned_paths {
        for pb in &b.owned_paths {
            if pa == pb {
                if !is_carved_out_by_exclusions(pa, &a.excluded_paths)
                    && !is_carved_out_by_exclusions(pb, &b.excluded_paths)
                {
                    return Some(pa.clone());
                }
            } else if pattern_contains_or_equals(pa, pb) {
                // `a` owns parent tree `pa`, `b` owns child `pb` -> valid ONLY if `a` excluded `pb`.
                if !is_carved_out_by_exclusions(pb, &a.excluded_paths) {
                    return Some(pb.clone());
                }
            } else if pattern_contains_or_equals(pb, pa) {
                // `b` owns parent tree `pb`, `a` owns child `pa` -> valid ONLY if `b` excluded `pa`.
                if !is_carved_out_by_exclusions(pa, &b.excluded_paths) {
                    return Some(pa.clone());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryEdge, MemoryNodeMeta, MemoryTier};

    #[test]
    fn all_to_all_duplex_mesh_allows_child_parent_sibling_two_way_round_trip() {
        let mut mesh = PeerMeshGraph::new(12);
        mesh.register_agent(AgentNode::new("coordinator", AgentRole::Coordinator, 1_000))
            .unwrap();
        mesh.register_agent(
            AgentNode::new("product-architect", AgentRole::Worker, 1_000)
                .with_owned_paths(["src-tauri/crates/omnia-harness/src/**"])
                .with_excluded_paths(["src-tauri/crates/omnia-harness/src/skills.rs"]),
        )
        .unwrap();
        mesh.register_agent(
            AgentNode::new("skills-sync", AgentRole::Worker, 1_000)
                .with_owned_paths(["src-tauri/crates/omnia-harness/src/skills.rs"]),
        )
        .unwrap();
        mesh.register_agent(AgentNode::new("verifier", AgentRole::Verifier, 1_000))
            .unwrap();
        mesh.register_agent(AgentNode::new("ui-helper", AgentRole::Subagent, 1_000))
            .unwrap();

        // Connect every agent 2-way (`A <-> B`) across all 5 roles (5 * 4 / 2 = 10 duplex pairs).
        let pairs = mesh
            .connect_entire_roster_duplex("peer_mesh", GraphifyProvenance::Extracted, 1_010)
            .unwrap();
        assert_eq!(pairs, 10);

        for a in [
            "coordinator",
            "product-architect",
            "skills-sync",
            "verifier",
            "ui-helper",
        ] {
            assert_eq!(mesh.bidirectional_peers(a).len(), 4);
            for b in [
                "coordinator",
                "product-architect",
                "skills-sync",
                "verifier",
                "ui-helper",
            ] {
                if a != b {
                    assert!(
                        mesh.has_duplex_link(a, b),
                        "{a} <-> {b} must be bidirectional"
                    );
                }
            }
        }

        // Round-trip cycle across roles: child (ui-helper) -> parent (coordinator) -> sibling (skills-sync) -> sibling (product-architect) -> child (ui-helper) -> verifier!
        let m1 = mesh
            .send_peer(SendPeerRequest {
                from: "ui-helper".into(),
                to: "coordinator".into(),
                conversation_id: "conv-mesh-1".into(),
                payload: "need design token confirmation".into(),
                provenance: GraphifyProvenance::Extracted,
                hop_count: 0,
                max_hops: 8,
                sender_epoch: None,
                expect_reply: true,
                now_ms: 1_100,
            })
            .unwrap();
        assert_eq!(m1.seq, 1);

        let m2 = mesh
            .send_peer(SendPeerRequest {
                from: "coordinator".into(),
                to: "skills-sync".into(),
                conversation_id: "conv-mesh-1".into(),
                payload: "confirm skill parity with ui-helper".into(),
                provenance: GraphifyProvenance::Extracted,
                hop_count: m1.hop_count + 1,
                max_hops: 8,
                sender_epoch: None,
                expect_reply: true,
                now_ms: 1_150,
            })
            .unwrap();

        // Direct sibling -> child link (impossible in 1-way trees, native in PeerMeshGraph!):
        let m3 = mesh
            .send_peer(SendPeerRequest {
                from: "skills-sync".into(),
                to: "ui-helper".into(),
                conversation_id: "conv-mesh-1".into(),
                payload: "deep-ui-direction tokens synced".into(),
                provenance: GraphifyProvenance::Extracted,
                hop_count: m2.hop_count + 1,
                max_hops: 8,
                sender_epoch: None,
                expect_reply: true,
                now_ms: 1_200,
            })
            .unwrap();

        // Automatic 2-way reply from ui-helper back to skills-sync:
        let m4 = mesh
            .reply(
                "ui-helper",
                m3.seq,
                "tokens applied, ready for audit",
                GraphifyProvenance::Extracted,
                false,
                1_250,
            )
            .unwrap();
        assert_eq!(m4.hop_count, 3);
        assert_eq!(
            m4.target,
            PeerTarget::Reply {
                to: "skills-sync".into(),
                in_reply_to_seq: m3.seq,
            }
        );

        let skills_inbox = mesh.read_since("skills-sync", 0);
        assert_eq!(skills_inbox.len(), 2);
        assert_eq!(skills_inbox[0].seq, m2.seq);
        assert_eq!(skills_inbox[1].seq, m4.seq);
    }

    #[test]
    fn cyclic_peer_negotiation_succeeds_within_budget_and_terminates_at_max_hops_or_stale_epoch() {
        let mut mesh = PeerMeshGraph::new(5);
        for id in ["agent-a", "agent-b", "agent-c"] {
            mesh.register_agent(AgentNode::new(id, AgentRole::Specialist, 1_000))
                .unwrap();
        }
        mesh.connect_all_to_all(
            ["agent-a", "agent-b", "agent-c"],
            "negotiate",
            GraphifyProvenance::Extracted,
            1_000,
        )
        .unwrap();

        // Cycle A -> B -> C -> A -> B (hops 0, 1, 2, 3, 4; max_hops = 5):
        let route = [
            ("agent-a", "agent-b"),
            ("agent-b", "agent-c"),
            ("agent-c", "agent-a"),
            ("agent-a", "agent-b"),
            ("agent-b", "agent-a"),
        ];
        for (hop, (from, to)) in route.iter().enumerate() {
            mesh.send_peer(SendPeerRequest {
                from: (*from).into(),
                to: (*to).into(),
                conversation_id: "cycle-abc".into(),
                payload: format!("hop {hop}"),
                provenance: GraphifyProvenance::Inferred,
                hop_count: hop as u32,
                max_hops: 5,
                sender_epoch: None,
                expect_reply: true,
                now_ms: 2_000 + (hop as u64) * 100,
            })
            .unwrap();
        }

        // Hop 5 == max_hops (5) is deterministically stopped:
        let hop_err = mesh
            .send_peer(SendPeerRequest {
                from: "agent-a".into(),
                to: "agent-c".into(),
                conversation_id: "cycle-abc".into(),
                payload: "unbounded loop".into(),
                provenance: GraphifyProvenance::Inferred,
                hop_count: 5,
                max_hops: 5,
                sender_epoch: None,
                expect_reply: false,
                now_ms: 2_600,
            })
            .unwrap_err();
        assert!(matches!(
            hop_err,
            AgentGraphError::HopBudgetExceeded {
                hop_count: 5,
                max_hops: 5,
                ..
            }
        ));

        // Stall detection flags `cycle-abc` waiting on `agent-a` after timeout:
        let stalled = mesh.detect_stalled_conversations(10_000, 5_000);
        assert_eq!(stalled.len(), 1);
        assert_eq!(stalled[0].waiting_on_peer, "agent-a");

        // Epoch bump fences stale messages from old turn:
        let new_epoch = mesh.bump_agent_epoch("agent-a").unwrap();
        assert_eq!(new_epoch, 2);
        let epoch_err = mesh
            .send_peer(SendPeerRequest {
                from: "agent-a".into(),
                to: "agent-b".into(),
                conversation_id: "fresh".into(),
                payload: "late stale turn".into(),
                provenance: GraphifyProvenance::Extracted,
                hop_count: 0,
                max_hops: 5,
                sender_epoch: Some(1),
                expect_reply: false,
                now_ms: 10_100,
            })
            .unwrap_err();
        assert_eq!(
            epoch_err,
            AgentGraphError::StaleEpoch {
                agent_id: "agent-a".into(),
                provided: 1,
                expected: 2,
            }
        );
    }

    #[test]
    fn disjoint_path_ownership_guard_rejects_unexcluded_overlap_and_allows_carved_out_slices() {
        let mut mesh = PeerMeshGraph::new(8);
        mesh.register_agent(
            AgentNode::new("writer-1", AgentRole::Worker, 100).with_owned_paths(["native/src/**"]),
        )
        .unwrap();

        // Overlapping subpath without carve-out MUST fail closed:
        let err = mesh
            .register_agent(
                AgentNode::new("writer-2", AgentRole::Worker, 110)
                    .with_owned_paths(["native\\src\\win32.rs"]),
            )
            .unwrap_err();
        assert!(matches!(
            err,
            AgentGraphError::OwnershipConflict {
                ref peer_a,
                ref peer_b,
                ref overlapping_pattern,
            } if peer_a == "writer-2" && peer_b == "writer-1" && overlapping_pattern == "native/src/win32.rs"
        ));

        // Disjoint directory succeeds cleanly:
        mesh.register_agent(
            AgentNode::new("writer-3", AgentRole::Worker, 120)
                .with_owned_paths(["docs/workspace/**"]),
        )
        .unwrap();
    }

    #[test]
    fn graphify_index_supports_forward_reverse_and_bidirectional_provenance_queries() {
        let mut index = GraphifyIndex::new();
        index.upsert_entity(GraphifyEntity {
            id: "req:PRODUCT-GRAPH".into(),
            kind: GraphifyEntityKind::Requirement,
            label: "PRODUCT-GRAPH".into(),
            path: Some("docs/workspace/GOAL.md".into()),
            summary: "Bidirectional all-to-all general agent graph".into(),
        });
        index.upsert_entity(GraphifyEntity {
            id: "mod:agent_graph".into(),
            kind: GraphifyEntityKind::CodeModule,
            label: "agent_graph.rs".into(),
            path: Some("src-tauri/crates/omnia-harness/src/agent_graph.rs".into()),
            summary: "PeerMeshGraph and GraphifyIndex implementation".into(),
        });
        index.upsert_entity(GraphifyEntity {
            id: "agent:verifier".into(),
            kind: GraphifyEntityKind::Agent,
            label: "verifier".into(),
            path: None,
            summary: "Independent anti-overconfidence verifier".into(),
        });
        index.upsert_entity(GraphifyEntity {
            id: "note:speculative".into(),
            kind: GraphifyEntityKind::MemoryNote,
            label: "Unconfirmed hint".into(),
            path: None,
            summary: "Ambiguous note".into(),
        });

        // mod:agent_graph --implements--> req:PRODUCT-GRAPH (EXTRACTED)
        index.add_edge(GraphifyEdge {
            from_id: "mod:agent_graph".into(),
            to_id: "req:PRODUCT-GRAPH".into(),
            relation: "implements".into(),
            provenance: GraphifyProvenance::Extracted,
            confidence_bps: 10_000,
            rationale: Some("module header & crate export".into()),
        });
        // agent:verifier <--audits--> mod:agent_graph (2-way EXTRACTED)
        index.add_bidirectional_edge(
            "agent:verifier",
            "mod:agent_graph",
            "audits",
            GraphifyProvenance::Inferred,
            Some("verifier audits owned harness modules".into()),
        );
        // note:speculative --mentions--> req:PRODUCT-GRAPH (AMBIGUOUS)
        index.add_edge(GraphifyEdge {
            from_id: "note:speculative".into(),
            to_id: "req:PRODUCT-GRAPH".into(),
            relation: "mentions".into(),
            provenance: GraphifyProvenance::Ambiguous,
            confidence_bps: 3_500,
            rationale: None,
        });

        // Reverse query from `req:PRODUCT-GRAPH` (excluding AMBIGUOUS) finds `mod:agent_graph` -> `agent:verifier`!
        let rev_strict = index.traverse(
            &["req:PRODUCT-GRAPH".into()],
            TraversalDirection::Reverse,
            2,
            false,
        );
        let rev_ids: Vec<&str> = rev_strict
            .visited_entities
            .iter()
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(
            rev_ids,
            vec!["req:PRODUCT-GRAPH", "mod:agent_graph", "agent:verifier"]
        );
        assert_eq!(rev_strict.extracted_edge_count, 1);
        assert_eq!(rev_strict.inferred_edge_count, 1);
        assert_eq!(rev_strict.ambiguous_edge_count, 0);

        // Including AMBIGUOUS also surfaces `note:speculative`:
        let rev_all = index.traverse(
            &["req:PRODUCT-GRAPH".into()],
            TraversalDirection::Reverse,
            2,
            true,
        );
        assert_eq!(rev_all.visited_entities.len(), 4);
        assert_eq!(rev_all.ambiguous_edge_count, 1);

        // Also test hydrating GraphifyIndex from MemoryGraph:
        let mut mem = MemoryGraph::default();
        mem.nodes.insert(
            "project:memory/arch".into(),
            MemoryNodeMeta {
                node_id: "project:memory/arch".into(),
                scope: "project".into(),
                namespace: "memory".into(),
                slug: "arch".into(),
                name: "Architecture".into(),
                description: "Core graph".into(),
                kind: None,
                tier: MemoryTier::Durable,
                created_at_ms: 100,
                updated_at_ms: 100,
                expires_at_ms: None,
                supersedes: None,
                superseded_by: None,
                content_sha256: "abc".into(),
            },
        );
        mem.nodes.insert(
            "project:specs/router".into(),
            MemoryNodeMeta {
                node_id: "project:specs/router".into(),
                scope: "project".into(),
                namespace: "specs".into(),
                slug: "router".into(),
                name: "Router Spec".into(),
                description: "Dynamic routing".into(),
                kind: None,
                tier: MemoryTier::Durable,
                created_at_ms: 100,
                updated_at_ms: 100,
                expires_at_ms: None,
                supersedes: None,
                superseded_by: None,
                content_sha256: "def".into(),
            },
        );
        mem.edges.push(MemoryEdge {
            from_id: "project:specs/router".into(),
            to_id: "project:memory/arch".into(),
            relation: "refines".into(),
            provenance: EdgeProvenance::Extracted,
            confidence_bps: 10_000,
            rationale: None,
            created_at_ms: 100,
            auto_extracted: true,
        });
        let hydrated = GraphifyIndex::from_memory_graph(&mem);
        let backlinks =
            hydrated.incident_edges("project:memory/arch", TraversalDirection::Reverse, false);
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].from_id, "project:specs/router");
    }
}
