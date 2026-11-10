//! Deterministic, local-only provider transport fault harness.
//!
//! The harness is compiled only for native tests. It deliberately works below
//! the provider adapter boundary so conformance tests can control response
//! bytes, EOF, and request/response checkpoints without a live provider or
//! timing-based sleeps. Test scenarios must use synthetic credentials and
//! prompts because captured requests intentionally retain their exact bytes.

use std::{
    collections::{BTreeSet, HashSet},
    fmt,
    net::{Ipv4Addr, SocketAddr},
    time::Duration,
};

use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};

const DEFAULT_REQUEST_LIMIT: usize = 2 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 16;
const MAX_STEPS_PER_CONNECTION: usize = 256;
const MAX_OUTBOUND_BYTES: usize = 32 * 1024 * 1024;
const MAX_HEADER_COUNT: usize = 128;
const MAX_NAME_BYTES: usize = 128;
const OBSERVATION_QUEUE_CAPACITY: usize = 8_192;
const CONTROL_QUEUE_CAPACITY: usize = 512;
const MAX_FRAGMENT_CHUNKS: usize = MAX_STEPS_PER_CONNECTION - 2;
const MAX_FRAGMENT_SPLITS: usize = MAX_FRAGMENT_CHUNKS - 1;

#[derive(Clone, Debug)]
pub(crate) struct ProviderFaultScenario {
    name: String,
    request_limit: usize,
    connections: Vec<ProviderConnectionScript>,
}

impl ProviderFaultScenario {
    pub(crate) fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            request_limit: DEFAULT_REQUEST_LIMIT,
            connections: Vec::new(),
        }
    }

    pub(crate) fn request_limit(mut self, request_limit: usize) -> Self {
        self.request_limit = request_limit;
        self
    }

    pub(crate) fn connection(mut self, connection: ProviderConnectionScript) -> Self {
        self.connections.push(connection);
        self
    }

    fn validate(&self) -> HarnessResult<()> {
        validate_name("scenario", &self.name)?;
        if self.request_limit == 0 {
            return Err(HarnessError::new(
                "The provider fault scenario request limit must be positive",
            ));
        }
        if self.connections.is_empty() || self.connections.len() > MAX_CONNECTIONS {
            return Err(HarnessError::new(format!(
                "A provider fault scenario must define between 1 and {MAX_CONNECTIONS} connections",
            )));
        }
        for connection in &self.connections {
            connection.validate()?;
        }
        Ok(())
    }

    fn checkpoint_keys(&self) -> HashSet<CheckpointKey> {
        self.connections
            .iter()
            .enumerate()
            .flat_map(|(connection_index, connection)| {
                connection.steps.iter().filter_map(move |step| match step {
                    ProviderFaultStep::Checkpoint(name) => Some(CheckpointKey {
                        connection_index,
                        name: name.clone(),
                    }),
                    _ => None,
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderConnectionScript {
    name: String,
    steps: Vec<ProviderFaultStep>,
}

impl ProviderConnectionScript {
    pub(crate) fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            steps: Vec::new(),
        }
    }

    pub(crate) fn response_head<H, N, V>(
        mut self,
        status: u16,
        reason: impl Into<String>,
        headers: H,
    ) -> Self
    where
        H: IntoIterator<Item = (N, V)>,
        N: Into<String>,
        V: Into<String>,
    {
        self.steps.push(ProviderFaultStep::ResponseHead {
            status,
            reason: reason.into(),
            headers: headers
                .into_iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect(),
        });
        self
    }

    pub(crate) fn bytes(mut self, bytes: impl Into<Vec<u8>>) -> Self {
        self.steps.push(ProviderFaultStep::Bytes(bytes.into()));
        self
    }

    pub(crate) fn fragmented_bytes(
        mut self,
        canonical_bytes: &[u8],
        plan: &FragmentationPlan,
    ) -> HarnessResult<Self> {
        for chunk in plan.chunks(canonical_bytes)? {
            self.steps.push(ProviderFaultStep::Bytes(chunk.to_vec()));
        }
        Ok(self)
    }

    pub(crate) fn checkpoint(mut self, name: impl Into<String>) -> Self {
        self.steps.push(ProviderFaultStep::Checkpoint(name.into()));
        self
    }

    pub(crate) fn shutdown_write(mut self) -> Self {
        self.steps.push(ProviderFaultStep::ShutdownWrite);
        self
    }

    pub(crate) fn close(mut self) -> Self {
        self.steps.push(ProviderFaultStep::Close);
        self
    }

    fn validate(&self) -> HarnessResult<()> {
        validate_name("connection", &self.name)?;
        if self.steps.is_empty() || self.steps.len() > MAX_STEPS_PER_CONNECTION {
            return Err(HarnessError::new(format!(
                "A provider connection script must define between 1 and {MAX_STEPS_PER_CONNECTION} steps",
            )));
        }

        let mut outbound_bytes = 0usize;
        let mut checkpoints = HashSet::new();
        let mut response_head_seen = false;
        let mut terminal_seen = false;
        for step in &self.steps {
            if terminal_seen {
                return Err(HarnessError::new(
                    "A provider connection script cannot contain steps after close or shutdown",
                ));
            }
            match step {
                ProviderFaultStep::ResponseHead {
                    status,
                    reason,
                    headers,
                } => {
                    if response_head_seen {
                        return Err(HarnessError::new(
                            "A provider connection script can send at most one typed response head",
                        ));
                    }
                    validate_response_head(*status, reason, headers)?;
                    response_head_seen = true;
                    outbound_bytes = outbound_bytes
                        .checked_add(serialized_response_head_len(*status, reason, headers))
                        .ok_or_else(|| {
                            HarnessError::new("Provider script byte count overflowed")
                        })?;
                }
                ProviderFaultStep::Bytes(bytes) => {
                    if !response_head_seen {
                        return Err(HarnessError::new(
                            "Exact provider body bytes require a typed response head first",
                        ));
                    }
                    outbound_bytes = outbound_bytes.checked_add(bytes.len()).ok_or_else(|| {
                        HarnessError::new("Provider script byte count overflowed")
                    })?;
                }
                ProviderFaultStep::Checkpoint(name) => {
                    validate_name("checkpoint", name)?;
                    if !checkpoints.insert(name) {
                        return Err(HarnessError::new(
                            "Checkpoint names must be unique within a connection script",
                        ));
                    }
                }
                ProviderFaultStep::ShutdownWrite | ProviderFaultStep::Close => {
                    terminal_seen = true;
                }
            }
            if outbound_bytes > MAX_OUTBOUND_BYTES {
                return Err(HarnessError::new(format!(
                    "A provider connection script cannot send more than {MAX_OUTBOUND_BYTES} bytes",
                )));
            }
        }
        if !terminal_seen {
            return Err(HarnessError::new(
                "A provider connection script must end with close or shutdown",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
enum ProviderFaultStep {
    ResponseHead {
        status: u16,
        reason: String,
        headers: Vec<(String, String)>,
    },
    Bytes(Vec<u8>),
    Checkpoint(String),
    ShutdownWrite,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FragmentationStrategy {
    Coalesced,
    EveryByte,
    FixedSize { chunk_bytes: usize },
    Seeded { max_splits: usize },
    ProtocolBoundaries { max_splits: usize },
    Replay,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FragmentationReplayMetadata {
    pub fixture_revision: String,
    pub fixture_sha256: String,
    pub seed: Option<u64>,
    pub split_offsets: Vec<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FragmentationPlan {
    strategy: FragmentationStrategy,
    metadata: FragmentationReplayMetadata,
}

impl FragmentationPlan {
    pub(crate) fn coalesced(
        fixture_revision: impl Into<String>,
        canonical_bytes: &[u8],
    ) -> HarnessResult<Self> {
        Self::build(
            fixture_revision.into(),
            canonical_bytes,
            FragmentationStrategy::Coalesced,
            None,
            Vec::new(),
        )
    }

    pub(crate) fn every_byte(
        fixture_revision: impl Into<String>,
        canonical_bytes: &[u8],
    ) -> HarnessResult<Self> {
        if canonical_bytes.len() > MAX_FRAGMENT_CHUNKS {
            return Err(HarnessError::new(
                "Every-byte fragmentation exceeded the bounded script capacity",
            ));
        }
        Self::build(
            fixture_revision.into(),
            canonical_bytes,
            FragmentationStrategy::EveryByte,
            None,
            (1..canonical_bytes.len()).collect(),
        )
    }

    pub(crate) fn fixed_size(
        fixture_revision: impl Into<String>,
        canonical_bytes: &[u8],
        chunk_bytes: usize,
    ) -> HarnessResult<Self> {
        if chunk_bytes == 0 {
            return Err(HarnessError::new(
                "A fixed-size fragmentation chunk must be positive",
            ));
        }
        let chunk_count = canonical_bytes.len().div_ceil(chunk_bytes);
        if chunk_count > MAX_FRAGMENT_CHUNKS {
            return Err(HarnessError::new(
                "Fixed-size fragmentation exceeded the bounded script capacity",
            ));
        }
        Self::build(
            fixture_revision.into(),
            canonical_bytes,
            FragmentationStrategy::FixedSize { chunk_bytes },
            None,
            (chunk_bytes..canonical_bytes.len())
                .step_by(chunk_bytes)
                .collect(),
        )
    }

    pub(crate) fn seeded(
        fixture_revision: impl Into<String>,
        canonical_bytes: &[u8],
        seed: u64,
        max_splits: usize,
    ) -> HarnessResult<Self> {
        validate_fragment_split_limit(max_splits)?;
        let fixture_revision = fixture_revision.into();
        validate_name("fixture revision", &fixture_revision)?;
        let split_count = max_splits.min(canonical_bytes.len().saturating_sub(1));
        let state = fragmentation_state(&fixture_revision, canonical_bytes, seed, b"seeded");
        let mut split_offsets =
            deterministic_indices(canonical_bytes.len().saturating_sub(1), split_count, state)
                .into_iter()
                .map(|index| index + 1)
                .collect::<Vec<_>>();
        split_offsets.sort_unstable();
        Self::build(
            fixture_revision,
            canonical_bytes,
            FragmentationStrategy::Seeded { max_splits },
            Some(seed),
            split_offsets,
        )
    }

    pub(crate) fn protocol_boundaries(
        fixture_revision: impl Into<String>,
        canonical_bytes: &[u8],
        seed: u64,
        max_splits: usize,
    ) -> HarnessResult<Self> {
        validate_fragment_split_limit(max_splits)?;
        let fixture_revision = fixture_revision.into();
        validate_name("fixture revision", &fixture_revision)?;
        let state = fragmentation_state(
            &fixture_revision,
            canonical_bytes,
            seed,
            b"protocol-boundaries",
        );
        let split_offsets = select_protocol_boundaries(canonical_bytes, max_splits, state);
        Self::build(
            fixture_revision,
            canonical_bytes,
            FragmentationStrategy::ProtocolBoundaries { max_splits },
            Some(seed),
            split_offsets,
        )
    }

    pub(crate) fn replay(
        canonical_bytes: &[u8],
        metadata: FragmentationReplayMetadata,
    ) -> HarnessResult<Self> {
        validate_name("fixture revision", &metadata.fixture_revision)?;
        validate_sha256_hex(&metadata.fixture_sha256)?;
        if metadata.fixture_sha256 != sha256_hex(canonical_bytes) {
            return Err(HarnessError::new(
                "Fragmentation replay fixture hash did not match",
            ));
        }
        validate_split_offsets(canonical_bytes.len(), &metadata.split_offsets)?;
        Ok(Self {
            strategy: FragmentationStrategy::Replay,
            metadata,
        })
    }

    pub(crate) fn strategy(&self) -> &FragmentationStrategy {
        &self.strategy
    }

    pub(crate) fn replay_metadata(&self) -> FragmentationReplayMetadata {
        self.metadata.clone()
    }

    pub(crate) fn split_offsets(&self) -> &[usize] {
        &self.metadata.split_offsets
    }

    pub(crate) fn chunks<'a>(&self, canonical_bytes: &'a [u8]) -> HarnessResult<Vec<&'a [u8]>> {
        if self.metadata.fixture_sha256 != sha256_hex(canonical_bytes) {
            return Err(HarnessError::new(
                "Fragmentation plan fixture hash did not match",
            ));
        }
        validate_split_offsets(canonical_bytes.len(), &self.metadata.split_offsets)?;
        if canonical_bytes.is_empty() {
            return Ok(Vec::new());
        }

        let mut chunks = Vec::with_capacity(self.metadata.split_offsets.len() + 1);
        let mut start = 0;
        for &end in &self.metadata.split_offsets {
            chunks.push(&canonical_bytes[start..end]);
            start = end;
        }
        chunks.push(&canonical_bytes[start..]);
        Ok(chunks)
    }

    pub(crate) fn chunk_lengths(&self, canonical_bytes: &[u8]) -> HarnessResult<Vec<usize>> {
        Ok(self
            .chunks(canonical_bytes)?
            .into_iter()
            .map(<[u8]>::len)
            .collect())
    }

    fn build(
        fixture_revision: String,
        canonical_bytes: &[u8],
        strategy: FragmentationStrategy,
        seed: Option<u64>,
        split_offsets: Vec<usize>,
    ) -> HarnessResult<Self> {
        validate_name("fixture revision", &fixture_revision)?;
        validate_split_offsets(canonical_bytes.len(), &split_offsets)?;
        Ok(Self {
            strategy,
            metadata: FragmentationReplayMetadata {
                fixture_revision,
                fixture_sha256: sha256_hex(canonical_bytes),
                seed,
                split_offsets,
            },
        })
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct CapturedHttpRequest {
    pub method: String,
    pub target: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl fmt::Debug for CapturedHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedHttpRequest")
            .field("method", &self.method)
            .field("target_bytes", &self.target.len())
            .field("version", &self.version)
            .field(
                "header_names",
                &self
                    .headers
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

impl CapturedHttpRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProviderFaultObservation {
    RequestCaptured {
        connection_index: usize,
        connection_name: String,
        request: CapturedHttpRequest,
    },
    BytesSent {
        connection_index: usize,
        step_index: usize,
        byte_count: usize,
    },
    CheckpointReached {
        connection_index: usize,
        name: String,
    },
    WriteHalfClosed {
        connection_index: usize,
    },
    ConnectionClosed {
        connection_index: usize,
    },
    ScenarioCompleted,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CheckpointKey {
    connection_index: usize,
    name: String,
}

#[derive(Debug)]
enum HarnessControl {
    Release(CheckpointKey),
}

#[derive(Debug)]
pub(crate) struct ProviderFaultReport {
    pub scenario_name: String,
    pub observations: Vec<ProviderFaultObservation>,
}

impl ProviderFaultReport {
    pub(crate) fn captured_request(&self, connection_index: usize) -> Option<&CapturedHttpRequest> {
        self.observations
            .iter()
            .find_map(|observation| match observation {
                ProviderFaultObservation::RequestCaptured {
                    connection_index: observed,
                    request,
                    ..
                } if *observed == connection_index => Some(request),
                _ => None,
            })
    }
}

pub(crate) struct ProviderFaultHarness {
    scenario_name: String,
    address: SocketAddr,
    control_tx: mpsc::Sender<HarnessControl>,
    observation_rx: mpsc::Receiver<ProviderFaultObservation>,
    observations: Vec<ProviderFaultObservation>,
    join: JoinHandle<HarnessResult<()>>,
    wait_timeout: Duration,
    connection_count: usize,
    checkpoints: HashSet<CheckpointKey>,
}

impl ProviderFaultHarness {
    pub(crate) async fn spawn(scenario: ProviderFaultScenario) -> HarnessResult<Self> {
        scenario.validate()?;
        let scenario_name = scenario.name.clone();
        let connection_count = scenario.connections.len();
        let checkpoints = scenario.checkpoint_keys();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| HarnessError::io("bind the provider fault listener", error))?;
        let address = listener
            .local_addr()
            .map_err(|error| HarnessError::io("read the provider fault listener address", error))?;
        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let (observation_tx, observation_rx) = mpsc::channel(OBSERVATION_QUEUE_CAPACITY);
        let join = tokio::spawn(run_scenario(listener, scenario, control_rx, observation_tx));
        Ok(Self {
            scenario_name,
            address,
            control_tx,
            observation_rx,
            observations: Vec::new(),
            join,
            wait_timeout: DEFAULT_WAIT_TIMEOUT,
            connection_count,
            checkpoints,
        })
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(crate) fn http_url(&self, path: &str) -> String {
        let path = if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/{path}")
        };
        format!("http://{}{}", self.address, path)
    }

    pub(crate) fn wait_timeout(mut self, wait_timeout: Duration) -> Self {
        self.wait_timeout = wait_timeout;
        self
    }

    pub(crate) async fn wait_for_request(
        &mut self,
        connection_index: usize,
    ) -> HarnessResult<CapturedHttpRequest> {
        self.validate_connection_index(connection_index)?;
        if let Some(request) = self
            .observations
            .iter()
            .find_map(|observation| match observation {
                ProviderFaultObservation::RequestCaptured {
                    connection_index: observed,
                    request,
                    ..
                } if *observed == connection_index => Some(request.clone()),
                _ => None,
            })
        {
            return Ok(request);
        }
        loop {
            let observation = self.next_observation().await?;
            if let ProviderFaultObservation::RequestCaptured {
                connection_index: observed,
                request,
                ..
            } = observation
            {
                if observed == connection_index {
                    return Ok(request);
                }
            }
        }
    }

    pub(crate) async fn wait_for_checkpoint(
        &mut self,
        connection_index: usize,
        expected_name: &str,
    ) -> HarnessResult<()> {
        let key = CheckpointKey {
            connection_index,
            name: expected_name.to_owned(),
        };
        self.validate_checkpoint(&key)?;
        if self.observations.iter().any(|observation| {
            matches!(
                observation,
                ProviderFaultObservation::CheckpointReached {
                    connection_index: observed,
                    name: observed_name,
                } if *observed == connection_index && observed_name == expected_name
            )
        }) {
            return Ok(());
        }
        loop {
            let observation = self.next_observation().await?;
            if matches!(
                observation,
                ProviderFaultObservation::CheckpointReached {
                    connection_index: observed,
                    name: ref observed_name,
                } if observed == connection_index && observed_name == expected_name
            ) {
                return Ok(());
            }
        }
    }

    pub(crate) async fn release_checkpoint(
        &self,
        connection_index: usize,
        name: impl Into<String>,
    ) -> HarnessResult<()> {
        let key = CheckpointKey {
            connection_index,
            name: name.into(),
        };
        self.validate_checkpoint(&key)?;
        self.control_tx
            .send(HarnessControl::Release(key))
            .await
            .map_err(|_| HarnessError::new("The provider fault server is no longer running"))
    }

    pub(crate) async fn finish(mut self) -> HarnessResult<ProviderFaultReport> {
        let completion = timeout(self.wait_timeout, async {
            loop {
                let observation = self.observation_rx.recv().await.ok_or_else(|| {
                    HarnessError::new("The provider fault observation stream closed")
                })?;
                let complete = observation == ProviderFaultObservation::ScenarioCompleted;
                self.observations.push(observation);
                if complete {
                    break;
                }
            }
            HarnessResult::<()>::Ok(())
        })
        .await;
        if completion.is_err() {
            self.join.abort();
            return Err(HarnessError::new(
                "Timed out waiting for the provider fault scenario",
            ));
        }
        completion.expect("timeout result was checked")?;

        let joined = timeout(self.wait_timeout, &mut self.join).await;
        let joined = match joined {
            Ok(joined) => joined,
            Err(_) => {
                self.join.abort();
                return Err(HarnessError::new(
                    "Timed out joining the provider fault scenario",
                ));
            }
        };
        joined
            .map_err(|error| HarnessError::new(format!("Provider fault task failed: {error}")))??;
        Ok(ProviderFaultReport {
            scenario_name: self.scenario_name.clone(),
            observations: self.observations.clone(),
        })
    }

    async fn next_observation(&mut self) -> HarnessResult<ProviderFaultObservation> {
        let observation = timeout(self.wait_timeout, self.observation_rx.recv())
            .await
            .map_err(|_| HarnessError::new("Timed out waiting for provider fault observation"))?
            .ok_or_else(|| HarnessError::new("The provider fault observation stream closed"))?;
        self.observations.push(observation.clone());
        Ok(observation)
    }

    fn validate_connection_index(&self, connection_index: usize) -> HarnessResult<()> {
        if connection_index >= self.connection_count {
            return Err(HarnessError::new(
                "Provider fault connection index was outside the scenario",
            ));
        }
        Ok(())
    }

    fn validate_checkpoint(&self, checkpoint: &CheckpointKey) -> HarnessResult<()> {
        self.validate_connection_index(checkpoint.connection_index)?;
        if !self.checkpoints.contains(checkpoint) {
            return Err(HarnessError::new(
                "Provider fault checkpoint was not declared by the scenario",
            ));
        }
        Ok(())
    }
}

impl Drop for ProviderFaultHarness {
    fn drop(&mut self) {
        self.join.abort();
    }
}

async fn run_scenario(
    listener: TcpListener,
    scenario: ProviderFaultScenario,
    mut control_rx: mpsc::Receiver<HarnessControl>,
    observation_tx: mpsc::Sender<ProviderFaultObservation>,
) -> HarnessResult<()> {
    let mut early_releases = HashSet::new();
    for (connection_index, script) in scenario.connections.into_iter().enumerate() {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|error| HarnessError::io("accept a provider connection", error))?;
        let request = capture_request(&mut socket, scenario.request_limit).await?;
        send_observation(
            &observation_tx,
            ProviderFaultObservation::RequestCaptured {
                connection_index,
                connection_name: script.name,
                request,
            },
        )
        .await?;

        for (step_index, step) in script.steps.into_iter().enumerate() {
            match step {
                ProviderFaultStep::ResponseHead {
                    status,
                    reason,
                    headers,
                } => {
                    let bytes = serialize_response_head(status, &reason, &headers);
                    write_exact_step(
                        &mut socket,
                        &observation_tx,
                        connection_index,
                        step_index,
                        &bytes,
                    )
                    .await?;
                }
                ProviderFaultStep::Bytes(bytes) => {
                    write_exact_step(
                        &mut socket,
                        &observation_tx,
                        connection_index,
                        step_index,
                        &bytes,
                    )
                    .await?;
                }
                ProviderFaultStep::Checkpoint(name) => {
                    let key = CheckpointKey {
                        connection_index,
                        name: name.clone(),
                    };
                    send_observation(
                        &observation_tx,
                        ProviderFaultObservation::CheckpointReached {
                            connection_index,
                            name,
                        },
                    )
                    .await?;
                    wait_for_release(&mut control_rx, &mut early_releases, key).await?;
                }
                ProviderFaultStep::ShutdownWrite => {
                    socket.shutdown().await.map_err(|error| {
                        HarnessError::io("half-close the provider socket", error)
                    })?;
                    send_observation(
                        &observation_tx,
                        ProviderFaultObservation::WriteHalfClosed { connection_index },
                    )
                    .await?;
                    break;
                }
                ProviderFaultStep::Close => break,
            }
        }
        drop(socket);
        send_observation(
            &observation_tx,
            ProviderFaultObservation::ConnectionClosed { connection_index },
        )
        .await?;
    }
    send_observation(&observation_tx, ProviderFaultObservation::ScenarioCompleted).await
}

async fn wait_for_release(
    control_rx: &mut mpsc::Receiver<HarnessControl>,
    early_releases: &mut HashSet<CheckpointKey>,
    expected: CheckpointKey,
) -> HarnessResult<()> {
    if early_releases.remove(&expected) {
        return Ok(());
    }
    loop {
        match control_rx.recv().await {
            Some(HarnessControl::Release(released)) if released == expected => return Ok(()),
            Some(HarnessControl::Release(released)) => {
                early_releases.insert(released);
            }
            None => {
                return Err(HarnessError::new(
                    "The provider fault controller closed at a checkpoint",
                ))
            }
        }
    }
}

async fn write_exact_step(
    socket: &mut TcpStream,
    observation_tx: &mpsc::Sender<ProviderFaultObservation>,
    connection_index: usize,
    step_index: usize,
    bytes: &[u8],
) -> HarnessResult<()> {
    socket
        .write_all(bytes)
        .await
        .map_err(|error| HarnessError::io("write provider response bytes", error))?;
    socket
        .flush()
        .await
        .map_err(|error| HarnessError::io("flush provider response bytes", error))?;
    send_observation(
        observation_tx,
        ProviderFaultObservation::BytesSent {
            connection_index,
            step_index,
            byte_count: bytes.len(),
        },
    )
    .await
}

async fn send_observation(
    observation_tx: &mpsc::Sender<ProviderFaultObservation>,
    observation: ProviderFaultObservation,
) -> HarnessResult<()> {
    observation_tx
        .send(observation)
        .await
        .map_err(|_| HarnessError::new("The provider fault observation receiver closed"))
}

async fn capture_request(
    socket: &mut TcpStream,
    request_limit: usize,
) -> HarnessResult<CapturedHttpRequest> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(index) = find_bytes(&bytes, b"\r\n\r\n") {
            break index + 4;
        }
        read_request_bytes(socket, &mut bytes, request_limit).await?;
    };

    let head = std::str::from_utf8(&bytes[..header_end - 4])
        .map_err(|_| HarnessError::new("Provider request headers were not valid UTF-8"))?
        .to_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HarnessError::new("Provider request line was missing"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("Provider request method was missing"))?;
    let target = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("Provider request target was missing"))?;
    let version = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("Provider request version was missing"))?;
    if request_parts.next().is_some() {
        return Err(HarnessError::new("Provider request line was malformed"));
    }

    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| HarnessError::new("Provider request header was malformed"))?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
    if headers.len() > MAX_HEADER_COUNT {
        return Err(HarnessError::new(
            "Provider request contained too many headers",
        ));
    }
    if headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
    {
        return Err(HarnessError::new(
            "Chunked provider requests are not supported by the deterministic capture harness",
        ));
    }

    let content_length = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| {
            value
                .parse::<usize>()
                .map_err(|_| HarnessError::new("Provider request Content-Length was invalid"))
        })
        .collect::<HarnessResult<Vec<_>>>()?;
    let content_length = match content_length.as_slice() {
        [] => 0,
        [value] => *value,
        _ => {
            return Err(HarnessError::new(
                "Provider request contained duplicate Content-Length headers",
            ))
        }
    };
    let expected_length = header_end
        .checked_add(content_length)
        .ok_or_else(|| HarnessError::new("Provider request length overflowed"))?;
    if expected_length > request_limit {
        return Err(HarnessError::new(
            "Provider request exceeded the configured capture limit",
        ));
    }
    while bytes.len() < expected_length {
        read_request_bytes(socket, &mut bytes, request_limit).await?;
    }
    if bytes.len() != expected_length {
        return Err(HarnessError::new(
            "Provider request contained bytes beyond its declared boundary",
        ));
    }

    Ok(CapturedHttpRequest {
        method: method.to_owned(),
        target: target.to_owned(),
        version: version.to_owned(),
        headers,
        body: bytes[header_end..expected_length].to_vec(),
    })
}

async fn read_request_bytes(
    socket: &mut TcpStream,
    bytes: &mut Vec<u8>,
    request_limit: usize,
) -> HarnessResult<()> {
    if bytes.len() >= request_limit {
        return Err(HarnessError::new(
            "Provider request exceeded the configured capture limit",
        ));
    }
    let remaining = request_limit - bytes.len();
    let mut buffer = [0_u8; 8 * 1024];
    let read_capacity = buffer.len().min(remaining);
    let read = socket
        .read(&mut buffer[..read_capacity])
        .await
        .map_err(|error| HarnessError::io("read provider request bytes", error))?;
    if read == 0 {
        return Err(HarnessError::new(
            "Provider request ended before its declared boundary",
        ));
    }
    bytes.extend_from_slice(&buffer[..read]);
    Ok(())
}

fn serialize_response_head(status: u16, reason: &str, headers: &[(String, String)]) -> Vec<u8> {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    head.into_bytes()
}

fn serialized_response_head_len(status: u16, reason: &str, headers: &[(String, String)]) -> usize {
    serialize_response_head(status, reason, headers).len()
}

fn validate_response_head(
    status: u16,
    reason: &str,
    headers: &[(String, String)],
) -> HarnessResult<()> {
    if !(100..=599).contains(&status) {
        return Err(HarnessError::new("Provider response status was invalid"));
    }
    validate_http_component("response reason", reason, true)?;
    if headers.len() > MAX_HEADER_COUNT {
        return Err(HarnessError::new(
            "Provider response contained too many headers",
        ));
    }
    for (name, value) in headers {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        {
            return Err(HarnessError::new(
                "Provider response header name was invalid",
            ));
        }
        validate_http_component("response header value", value, true)?;
    }
    Ok(())
}

fn validate_http_component(label: &str, value: &str, allow_space: bool) -> HarnessResult<()> {
    if value.len() > 8 * 1024
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_graphic() || allow_space && byte == b' '))
    {
        return Err(HarnessError::new(format!("Provider {label} was invalid")));
    }
    Ok(())
}

fn validate_name(label: &str, value: &str) -> HarnessResult<()> {
    if value.is_empty()
        || value.len() > MAX_NAME_BYTES
        || value.chars().any(|character| character.is_control())
    {
        return Err(HarnessError::new(format!(
            "Provider fault {label} name was invalid",
        )));
    }
    Ok(())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn validate_fragment_split_limit(max_splits: usize) -> HarnessResult<()> {
    if max_splits > MAX_FRAGMENT_SPLITS {
        return Err(HarnessError::new(format!(
            "A fragmentation plan cannot define more than {MAX_FRAGMENT_SPLITS} split offsets",
        )));
    }
    Ok(())
}

fn validate_split_offsets(canonical_len: usize, split_offsets: &[usize]) -> HarnessResult<()> {
    validate_fragment_split_limit(split_offsets.len())?;
    let mut previous = 0usize;
    for &offset in split_offsets {
        if offset == 0 || offset >= canonical_len || offset <= previous {
            return Err(HarnessError::new(
                "Fragmentation split offsets must be unique, ordered, and inside the fixture",
            ));
        }
        previous = offset;
    }
    Ok(())
}

fn validate_sha256_hex(value: &str) -> HarnessResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HarnessError::new(
            "Fragmentation fixture hash was not canonical SHA-256 hex",
        ));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fragmentation_state(
    fixture_revision: &str,
    canonical_bytes: &[u8],
    seed: u64,
    strategy_domain: &[u8],
) -> u64 {
    let mut digest = Sha256::new();
    digest.update(b"omnia-provider-fault-fragmentation-v1");
    digest.update((fixture_revision.len() as u64).to_be_bytes());
    digest.update(fixture_revision.as_bytes());
    digest.update((strategy_domain.len() as u64).to_be_bytes());
    digest.update(strategy_domain);
    digest.update(seed.to_be_bytes());
    digest.update((canonical_bytes.len() as u64).to_be_bytes());
    digest.update(canonical_bytes);
    let hash = digest.finalize();
    u64::from_be_bytes(hash[..8].try_into().expect("SHA-256 prefix is eight bytes"))
}

fn deterministic_indices(total: usize, count: usize, state: u64) -> Vec<usize> {
    if count == 0 || total == 0 {
        return Vec::new();
    }

    let count = count.min(total);
    let mut generator = DeterministicGenerator::new(state);
    let mut selected = BTreeSet::new();
    for upper in (total - count)..total {
        let candidate = generator.next_bounded(upper + 1);
        if !selected.insert(candidate) {
            selected.insert(upper);
        }
    }
    selected.into_iter().collect()
}

fn select_protocol_boundaries(canonical_bytes: &[u8], max_splits: usize, state: u64) -> Vec<usize> {
    let mut candidates = BTreeSet::new();
    for offset in 1..canonical_bytes.len() {
        let previous = canonical_bytes[offset - 1];
        let current = canonical_bytes[offset];
        let inside_utf8_codepoint = current & 0b1100_0000 == 0b1000_0000;
        let around_line_boundary =
            matches!(previous, b'\r' | b'\n') || matches!(current, b'\r' | b'\n');
        let around_json_boundary =
            is_json_boundary_byte(previous) || is_json_boundary_byte(current);
        if inside_utf8_codepoint || around_line_boundary || around_json_boundary {
            candidates.insert(offset);
        }
    }

    let candidates = candidates.into_iter().collect::<Vec<_>>();
    if candidates.len() <= max_splits {
        return candidates;
    }
    deterministic_indices(candidates.len(), max_splits, state)
        .into_iter()
        .map(|index| candidates[index])
        .collect()
}

fn is_json_boundary_byte(byte: u8) -> bool {
    matches!(byte, b'{' | b'}' | b'[' | b']' | b',' | b':' | b'"' | b'\\')
}

struct DeterministicGenerator {
    state: u64,
}

impl DeterministicGenerator {
    fn new(state: u64) -> Self {
        Self { state }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }

    fn next_bounded(&mut self, upper_exclusive: usize) -> usize {
        debug_assert!(upper_exclusive > 0);
        (self.next_u64() % upper_exclusive as u64) as usize
    }
}

type HarnessResult<T> = Result<T, HarnessError>;

#[derive(Debug)]
pub(crate) struct HarnessError {
    message: String,
}

impl HarnessError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn io(action: &str, error: std::io::Error) -> Self {
        Self::new(format!("Could not {action}: {}", error.kind()))
    }
}

impl fmt::Display for HarnessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HarnessError {}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;
    use reqwest::Client;

    use super::*;

    fn sse_headers() -> [(String, String); 2] {
        [
            (
                "Content-Type".into(),
                "text/event-stream; charset=utf-8".into(),
            ),
            ("Connection".into(), "close".into()),
        ]
    }

    #[tokio::test]
    async fn captures_exact_request_scope_and_synthetic_canary() {
        let script = ProviderConnectionScript::new("capture-request")
            .response_head(
                200,
                "OK",
                [
                    ("Content-Type", "application/json"),
                    ("Content-Length", "2"),
                    ("Connection", "close"),
                ],
            )
            .bytes(b"{}".to_vec())
            .close();
        let scenario = ProviderFaultScenario::new("request-capture")
            .request_limit(16 * 1024)
            .connection(script);
        let mut harness = ProviderFaultHarness::spawn(scenario).await.unwrap();
        assert!(harness.address().ip().is_loopback());
        let response = tokio::spawn(
            Client::new()
                .post(harness.http_url("/v1/chat/completions?stream=true"))
                .header("Authorization", "Bearer OMNIA_SYNTHETIC_SECRET_CANARY")
                .body(r#"{"model":"fixture-model"}"#)
                .send(),
        );

        let request = harness.wait_for_request(0).await.unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/chat/completions?stream=true");
        assert_eq!(request.version, "HTTP/1.1");
        assert_eq!(
            request.header("authorization"),
            Some("Bearer OMNIA_SYNTHETIC_SECRET_CANARY")
        );
        assert_eq!(request.body, br#"{"model":"fixture-model"}"#);

        let response = response.await.unwrap().unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"{}");
        let report = harness.finish().await.unwrap();
        assert_eq!(report.scenario_name, "request-capture");
        assert_eq!(report.captured_request(0), Some(&request));
    }

    #[tokio::test]
    async fn checkpoint_stalls_without_sleep_and_releases_deterministically() {
        let script = ProviderConnectionScript::new("gated-stream")
            .checkpoint("before-response-head")
            .response_head(200, "OK", sse_headers())
            .bytes(b"data: [DONE]\n\n".to_vec())
            .shutdown_write();
        let scenario = ProviderFaultScenario::new("checkpoint-release").connection(script);
        let mut harness = ProviderFaultHarness::spawn(scenario)
            .await
            .unwrap()
            .wait_timeout(Duration::from_secs(3));
        let request = tokio::spawn(Client::new().get(harness.http_url("/stream")).send());

        harness.wait_for_request(0).await.unwrap();
        harness
            .wait_for_checkpoint(0, "before-response-head")
            .await
            .unwrap();
        assert!(!request.is_finished());
        harness
            .release_checkpoint(0, "before-response-head")
            .await
            .unwrap();

        let response = request.await.unwrap().unwrap();
        assert_eq!(
            response.bytes().await.unwrap().as_ref(),
            b"data: [DONE]\n\n"
        );
        let report = harness.finish().await.unwrap();
        assert!(report.observations.iter().any(|observation| matches!(
            observation,
            ProviderFaultObservation::WriteHalfClosed {
                connection_index: 0
            }
        )));
    }

    #[tokio::test]
    async fn writes_fragmented_utf8_and_sse_bytes_without_mutation() {
        let full_body =
            "data: {\"choices\":[{\"delta\":{\"content\":\"chào\"}}]}\n\ndata: [DONE]\n\n";
        let utf8 = full_body.as_bytes();
        let split = full_body.find('à').unwrap() + 1;
        let script = ProviderConnectionScript::new("fragmented-utf8")
            .response_head(200, "OK", sse_headers())
            .bytes(utf8[..split].to_vec())
            .checkpoint("inside-utf8-codepoint")
            .bytes(utf8[split..split + 1].to_vec())
            .bytes(utf8[split + 1..].to_vec())
            .close();
        let scenario = ProviderFaultScenario::new("fragmented-stream").connection(script);
        let mut harness = ProviderFaultHarness::spawn(scenario).await.unwrap();
        let request = tokio::spawn(Client::new().get(harness.http_url("/stream")).send());

        harness
            .wait_for_checkpoint(0, "inside-utf8-codepoint")
            .await
            .unwrap();
        harness
            .release_checkpoint(0, "inside-utf8-codepoint")
            .await
            .unwrap();
        let response = request.await.unwrap().unwrap();
        let mut body = response.bytes_stream();
        let mut received = Vec::new();
        while let Some(chunk) = body.next().await {
            received.extend_from_slice(&chunk.unwrap());
        }
        assert_eq!(received, utf8);
        harness.finish().await.unwrap();
    }

    #[test]
    fn seeded_fragmentation_is_deterministic_bounded_and_replayable() {
        let canonical =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"synthetic fixture\"}}]}\n\ndata: [DONE]\n\n";
        let first = FragmentationPlan::seeded("openai-text-v1", canonical, 0x5eed, 17).unwrap();
        let second = FragmentationPlan::seeded("openai-text-v1", canonical, 0x5eed, 17).unwrap();
        assert_eq!(first, second);
        assert!(matches!(
            first.strategy(),
            FragmentationStrategy::Seeded { max_splits: 17 }
        ));
        assert_eq!(first.split_offsets().len(), 17);
        assert!(first
            .split_offsets()
            .windows(2)
            .all(|offsets| offsets[0] < offsets[1]));

        let reconstructed = first
            .chunks(canonical)
            .unwrap()
            .into_iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(reconstructed, canonical);

        let metadata = first.replay_metadata();
        assert_eq!(metadata.fixture_revision, "openai-text-v1");
        assert_eq!(metadata.fixture_sha256.len(), 64);
        assert_eq!(metadata.seed, Some(0x5eed));
        let replay = FragmentationPlan::replay(canonical, metadata).unwrap();
        assert_eq!(replay.split_offsets(), first.split_offsets());
        assert_eq!(
            replay.chunk_lengths(canonical).unwrap(),
            first.chunk_lengths(canonical).unwrap()
        );
    }

    #[test]
    fn canonical_fragmentation_strategies_preserve_exact_bytes() {
        let canonical = b"0123456789";
        let plans = [
            FragmentationPlan::coalesced("coalesced-v1", canonical).unwrap(),
            FragmentationPlan::every_byte("every-byte-v1", canonical).unwrap(),
            FragmentationPlan::fixed_size("fixed-v1", canonical, 3).unwrap(),
        ];

        assert!(matches!(
            plans[0].strategy(),
            FragmentationStrategy::Coalesced
        ));
        assert!(matches!(
            plans[1].strategy(),
            FragmentationStrategy::EveryByte
        ));
        assert!(matches!(
            plans[2].strategy(),
            FragmentationStrategy::FixedSize { chunk_bytes: 3 }
        ));
        assert_eq!(plans[0].chunk_lengths(canonical).unwrap(), vec![10]);
        assert_eq!(
            plans[1].chunk_lengths(canonical).unwrap(),
            vec![1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
        );
        assert_eq!(plans[2].chunk_lengths(canonical).unwrap(), vec![3, 3, 3, 1]);

        for plan in plans {
            let reconstructed = plan
                .chunks(canonical)
                .unwrap()
                .into_iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            assert_eq!(reconstructed, canonical);
        }
    }

    #[test]
    fn protocol_fragmentation_covers_utf8_sse_and_json_boundaries() {
        let canonical = "data: {\"content\":\"chào\\nworld\"}\r\n\r\ndata: [DONE]\r\n\r\n";
        let bytes = canonical.as_bytes();
        let plan = FragmentationPlan::protocol_boundaries(
            "protocol-boundaries-v1",
            bytes,
            7,
            MAX_FRAGMENT_SPLITS,
        )
        .unwrap();

        let utf8_start = canonical.find('à').unwrap();
        assert!(plan.split_offsets().contains(&(utf8_start + 1)));
        let first_carriage_return = canonical.find('\r').unwrap();
        assert!(plan.split_offsets().contains(&first_carriage_return));
        assert!(plan.split_offsets().contains(&(first_carriage_return + 1)));
        let escaped_newline = canonical.find("\\n").unwrap();
        assert!(plan.split_offsets().contains(&escaped_newline));
        assert!(plan.split_offsets().contains(&(escaped_newline + 1)));

        let reconstructed = plan
            .chunks(bytes)
            .unwrap()
            .into_iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(reconstructed, bytes);
    }

    #[test]
    fn fragmentation_plans_fail_closed_on_invalid_or_tampered_metadata() {
        let canonical = b"synthetic-fixture";
        assert!(FragmentationPlan::fixed_size("fixed-v1", canonical, 0).is_err());
        assert!(
            FragmentationPlan::seeded("seeded-v1", canonical, 1, MAX_FRAGMENT_SPLITS + 1,).is_err()
        );
        assert!(FragmentationPlan::every_byte(
            "oversized-v1",
            &vec![0_u8; MAX_FRAGMENT_CHUNKS + 1],
        )
        .is_err());

        let plan = FragmentationPlan::fixed_size("fixed-v1", canonical, 3).unwrap();
        let mut duplicate = plan.replay_metadata();
        duplicate.split_offsets = vec![3, 3];
        assert!(FragmentationPlan::replay(canonical, duplicate).is_err());

        let mut outside = plan.replay_metadata();
        outside.split_offsets = vec![canonical.len()];
        assert!(FragmentationPlan::replay(canonical, outside).is_err());

        let mut invalid_hash = plan.replay_metadata();
        invalid_hash.fixture_sha256 = "A".repeat(64);
        assert!(FragmentationPlan::replay(canonical, invalid_hash).is_err());

        let tampered_fixture = b"synthetic-fixturE";
        assert!(FragmentationPlan::replay(tampered_fixture, plan.replay_metadata()).is_err());
        assert!(plan.chunks(tampered_fixture).is_err());
    }

    #[test]
    fn fragmentation_diagnostics_do_not_contain_fixture_bytes() {
        let fixture = b"OMNIA_SYNTHETIC_RESPONSE_SECRET_CANARY";
        let plan = FragmentationPlan::seeded("redacted-v1", fixture, 9, 5).unwrap();
        let diagnostic = format!("{plan:?}");
        assert!(!diagnostic.contains("OMNIA_SYNTHETIC_RESPONSE_SECRET_CANARY"));
        assert!(diagnostic.contains("fixture_sha256"));
        assert!(diagnostic.contains("split_offsets"));
        assert!(diagnostic.contains("seed"));
    }

    #[tokio::test]
    async fn fragmentation_plan_drives_exact_wire_bytes_and_write_observations() {
        let canonical =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"deterministic\"}}]}\n\ndata: [DONE]\n\n";
        let plan = FragmentationPlan::seeded("wire-v1", canonical, 42, 11).unwrap();
        let expected_chunk_lengths = plan.chunk_lengths(canonical).unwrap();
        let script = ProviderConnectionScript::new("generated-fragments")
            .response_head(200, "OK", sse_headers())
            .fragmented_bytes(canonical, &plan)
            .unwrap()
            .close();
        let scenario = ProviderFaultScenario::new("generated-fragments").connection(script);
        let harness = ProviderFaultHarness::spawn(scenario).await.unwrap();
        let response = Client::new()
            .get(harness.http_url("/generated-fragments"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.bytes().await.unwrap().as_ref(), canonical);

        let report = harness.finish().await.unwrap();
        let observed_chunk_lengths = report
            .observations
            .iter()
            .filter_map(|observation| match observation {
                ProviderFaultObservation::BytesSent {
                    connection_index: 0,
                    step_index,
                    byte_count,
                } if *step_index > 0 => Some(*byte_count),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(observed_chunk_lengths, expected_chunk_lengths);
    }

    #[tokio::test]
    async fn exact_truncated_boundary_is_observable_as_clean_eof() {
        let partial = b"data: {\"choices\":[{\"delta\":{\"content\":\"partial".to_vec();
        let script = ProviderConnectionScript::new("truncated-frame")
            .response_head(200, "OK", sse_headers())
            .bytes(partial.clone())
            .shutdown_write();
        let scenario = ProviderFaultScenario::new("truncated-eof").connection(script);
        let harness = ProviderFaultHarness::spawn(scenario).await.unwrap();
        let response = Client::new()
            .get(harness.http_url("/stream"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.bytes().await.unwrap().to_vec(), partial);
        harness.finish().await.unwrap();
    }

    #[test]
    fn invalid_scripts_fail_before_opening_a_listener() {
        let duplicate_checkpoints = ProviderFaultScenario::new("invalid").connection(
            ProviderConnectionScript::new("connection")
                .checkpoint("same")
                .checkpoint("same")
                .close(),
        );
        assert!(duplicate_checkpoints.validate().is_err());

        let write_after_close = ProviderFaultScenario::new("invalid").connection(
            ProviderConnectionScript::new("connection")
                .close()
                .bytes(b"late".to_vec()),
        );
        assert!(write_after_close.validate().is_err());

        let injected_header = ProviderFaultScenario::new("invalid").connection(
            ProviderConnectionScript::new("connection")
                .response_head(200, "OK", [("X-Test", "value\r\nInjected: true")])
                .close(),
        );
        assert!(injected_header.validate().is_err());

        let body_without_head = ProviderFaultScenario::new("invalid").connection(
            ProviderConnectionScript::new("connection")
                .bytes(b"raw".to_vec())
                .close(),
        );
        assert!(body_without_head.validate().is_err());

        let implicit_close = ProviderFaultScenario::new("invalid").connection(
            ProviderConnectionScript::new("connection").response_head(
                200,
                "OK",
                [("Content-Length", "0")],
            ),
        );
        assert!(implicit_close.validate().is_err());
    }

    #[tokio::test]
    async fn undeclared_checkpoint_and_connection_fail_without_waiting() {
        let scenario = ProviderFaultScenario::new("validation").connection(
            ProviderConnectionScript::new("connection")
                .checkpoint("declared")
                .response_head(200, "OK", [("Content-Length", "0")])
                .close(),
        );
        let mut harness = ProviderFaultHarness::spawn(scenario).await.unwrap();
        assert!(harness.wait_for_request(1).await.is_err());
        assert!(harness.wait_for_checkpoint(0, "typo").await.is_err());
        assert!(harness.release_checkpoint(0, "typo").await.is_err());

        let request = tokio::spawn(Client::new().get(harness.http_url("/validation")).send());
        harness.wait_for_request(0).await.unwrap();
        harness.wait_for_checkpoint(0, "declared").await.unwrap();
        harness.release_checkpoint(0, "declared").await.unwrap();
        assert_eq!(request.await.unwrap().unwrap().status(), 200);
        harness.finish().await.unwrap();
    }
}
