import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Clean-room descriptors for public and official agent harness lifecycle patterns.
 *
 * This module is deliberately a catalog/normalizer, not a transport client.
 * It never materializes credentials, URLs, headers, prompts, or raw provider
 * payloads. Native code may use the normalized result as an input to a
 * durable kernel protocol, while the renderer can safely inspect descriptors,
 * capabilities, KV-cache strategies, LTST memory modes, and evidence levels.
 */

export const OFFICIAL_HARNESS_FAMILY_IDS = Object.freeze([
  "openai-gpt-codex",
  "anthropic-claude-code",
  "google-gemini-agy",
  "custom-cache-first",
  "pi-code-cli",
  "opencode-cli",
  "hermes-self-improving",
  "strands-agent-graph",
  "oh-my-pi-openhands-kimi",
] as const);

export type OfficialHarnessFamilyId = (typeof OFFICIAL_HARNESS_FAMILY_IDS)[number];

export const LEGACY_OFFICIAL_HARNESS_IDS = Object.freeze([
  "openai-codex",
  "openhands",
  "cursor",
  "cursor-agent",
  "droid",
  "factory-droid",
  "kimi-k2",
  "oh-my-pi",
] as const);

export type LegacyOfficialHarnessId = (typeof LEGACY_OFFICIAL_HARNESS_IDS)[number];

export const OFFICIAL_HARNESS_IDS = Object.freeze([
  ...OFFICIAL_HARNESS_FAMILY_IDS,
  ...LEGACY_OFFICIAL_HARNESS_IDS,
] as const);

export type OfficialHarnessId = (typeof OFFICIAL_HARNESS_IDS)[number];

export const OFFICIAL_HARNESS_EVIDENCE_LEVELS = Object.freeze([
  "observed",
  "documented",
  "inferred",
  "unverified",
] as const);

export type OfficialHarnessEvidenceLevel = (typeof OFFICIAL_HARNESS_EVIDENCE_LEVELS)[number];

export type OfficialHarnessSourceBoundary =
  | "public-open-source"
  | "official-public-repository"
  | "official-public-documentation";

export interface OfficialHarnessSource {
  readonly repository: string;
  readonly revision: string;
  readonly tag?: string;
  readonly license?: string;
  readonly boundary: OfficialHarnessSourceBoundary;
  readonly observedAt: IsoTimestamp;
  readonly evidence: OfficialHarnessEvidenceLevel;
}

export const OFFICIAL_HARNESS_CAPABILITIES = Object.freeze([
  "thread-turn-item-lifecycle",
  "streaming-deltas",
  "session-resume",
  "approvals",
  "event-journal",
  "branching",
  "compaction",
  "subagents",
  "leases",
  "workspace-environment",
  "action-observation-events",
  "kv-cache-breakpoints",
  "multi-lsp-routing",
  "experience-distillation",
  "deterministic-dag-execution",
  "long-horizon-sandbox",
  "dfs-session-tree",
  "ltst-knowledge-tree",
] as const);

export type OfficialHarnessCapability = (typeof OFFICIAL_HARNESS_CAPABILITIES)[number];

export interface OfficialHarnessCapabilityClaim {
  readonly capability: OfficialHarnessCapability;
  readonly available: boolean;
  readonly evidence: OfficialHarnessEvidenceLevel;
  readonly note?: string;
}

export type OfficialHarnessCanonicalEntity =
  | "session"
  | "thread"
  | "turn"
  | "item"
  | "tool"
  | "approval"
  | "conversation"
  | "action"
  | "observation"
  | "event"
  | "memory"
  | "dag-node"
  | "unknown";

export type OfficialHarnessLifecyclePhase =
  | "created"
  | "started"
  | "resumed"
  | "delta"
  | "requested"
  | "appended"
  | "completed"
  | "failed"
  | "compacted"
  | "unknown";

export interface OfficialHarnessEventMapping {
  readonly sourceEventName: string;
  readonly canonicalEntity: OfficialHarnessCanonicalEntity;
  readonly phase: OfficialHarnessLifecyclePhase;
  readonly evidence: OfficialHarnessEvidenceLevel;
}

export type OfficialHarnessUriScheme = "omnia" | "codex" | "claude" | "agy";

export type OfficialHarnessMemoryMode =
  | "ltst-hierarchical-tree"
  | "experience-skill-distillation"
  | "dag-state-projection"
  | "sandbox-event-condensation";

export interface OfficialHarnessDescriptor {
  readonly schemaVersion: 1;
  readonly id: OfficialHarnessId;
  readonly displayName: string;
  readonly familyLabel?: string;
  readonly architectureSummary?: string;
  readonly protocolFamily?: string;
  readonly uriScheme?: OfficialHarnessUriScheme;
  readonly kvCacheStrategy?: string;
  readonly memoryIntegrationMode?: OfficialHarnessMemoryMode;
  readonly defaultModelId?: string;
  readonly targetThroughputTokPerSec?: number;
  readonly sources: readonly OfficialHarnessSource[];
  readonly capabilities: readonly OfficialHarnessCapabilityClaim[];
  readonly eventMappings: readonly OfficialHarnessEventMapping[];
  readonly deterministicNormalization: true;
}

export interface OfficialHarnessNormalizedEvent {
  readonly schemaVersion: 1;
  readonly harnessId: OfficialHarnessId;
  readonly sourceEventName: string;
  readonly canonicalEntity: OfficialHarnessCanonicalEntity;
  readonly phase: OfficialHarnessLifecyclePhase;
  readonly sourceId?: string;
  readonly parentSourceId?: string;
  readonly sequence?: number;
  readonly evidence: OfficialHarnessEvidenceLevel;
  readonly known: boolean;
}

export interface OfficialHarnessAdapter {
  descriptor(): OfficialHarnessDescriptor;
  normalizeEvent(input: unknown): OfficialHarnessNormalizedEvent;
}

const MAX_ID_LENGTH = 512;
const MAX_EVENT_NAME_LENGTH = 256;
const MAX_NOTE_LENGTH = 512;
const OPAQUE_REFERENCE = /^(?!https?:)(?!file:)(?!data:)(?!blob:)(?![A-Za-z]:[\\/])(?![\\/])(?!\\\\).+$/i;
const SECRET_LIKE_VALUE = /(?:^|\b)(?:sk-[a-z0-9]|rk-[a-z0-9]|gh[pousr]_[a-z0-9]|github_pat_[a-z0-9]|bearer\s+|api[-_]?key\s*[:=]|authorization\s*[:=])/i;

const LEGACY_HARNESS_ALIAS_MAP: Readonly<Record<LegacyOfficialHarnessId, OfficialHarnessFamilyId>> = Object.freeze({
  "openai-codex": "openai-gpt-codex",
  openhands: "oh-my-pi-openhands-kimi",
  cursor: "opencode-cli",
  "cursor-agent": "opencode-cli",
  droid: "strands-agent-graph",
  "factory-droid": "strands-agent-graph",
  "kimi-k2": "oh-my-pi-openhands-kimi",
  "oh-my-pi": "oh-my-pi-openhands-kimi",
});

export function resolveCanonicalOfficialHarnessId(harnessId: string): OfficialHarnessFamilyId {
  const normalized = assertNonBlank(harnessId, "official harness id", MAX_ID_LENGTH);
  if (normalized in LEGACY_HARNESS_ALIAS_MAP) {
    return LEGACY_HARNESS_ALIAS_MAP[normalized as LegacyOfficialHarnessId];
  }
  assertDomain(
    (OFFICIAL_HARNESS_FAMILY_IDS as readonly string[]).includes(normalized),
    "not_found",
    `Unknown official harness adapter: ${normalized}`,
  );
  return normalized as OfficialHarnessFamilyId;
}

function freezeSource(source: OfficialHarnessSource): OfficialHarnessSource {
  const repository = assertNonBlank(source.repository, "harness source repository", MAX_ID_LENGTH);
  const revision = assertNonBlank(source.revision, "harness source revision", MAX_ID_LENGTH);
  assertDomain(OPAQUE_REFERENCE.test(repository), "scope_violation", "Harness source repository must be an opaque provenance identifier.");
  assertDomain(OPAQUE_REFERENCE.test(revision), "scope_violation", "Harness source revision must be an opaque provenance identifier.");
  assertDomain(!SECRET_LIKE_VALUE.test(repository) && !SECRET_LIKE_VALUE.test(revision), "scope_violation", "Harness provenance cannot contain secret-like values.");
  assertIsoTimestamp(source.observedAt, "harness source observedAt");
  if (source.tag !== undefined) {
    const tag = assertNonBlank(source.tag, "harness source tag", MAX_ID_LENGTH);
    assertDomain(OPAQUE_REFERENCE.test(tag), "scope_violation", "Harness source tag must be an opaque provenance identifier.");
    assertDomain(!SECRET_LIKE_VALUE.test(tag), "scope_violation", "Harness source tag cannot contain secret-like values.");
  }
  if (source.license !== undefined) assertNonBlank(source.license, "harness source license", MAX_ID_LENGTH);
  assertDomain(OFFICIAL_HARNESS_EVIDENCE_LEVELS.includes(source.evidence), "invalid_argument", "Unsupported harness evidence level.");
  return Object.freeze({ ...source, repository, revision });
}

function freezeCapabilityClaim(claim: OfficialHarnessCapabilityClaim): OfficialHarnessCapabilityClaim {
  assertDomain(OFFICIAL_HARNESS_CAPABILITIES.includes(claim.capability), "invalid_argument", "Unsupported harness capability.");
  assertDomain(typeof claim.available === "boolean", "invalid_argument", "Harness capability availability must be boolean.");
  assertDomain(OFFICIAL_HARNESS_EVIDENCE_LEVELS.includes(claim.evidence), "invalid_argument", "Unsupported harness capability evidence level.");
  const note = claim.note === undefined ? undefined : assertNonBlank(claim.note, "harness capability note", MAX_NOTE_LENGTH);
  return Object.freeze({ ...claim, ...(note === undefined ? {} : { note }) });
}

function freezeMapping(mapping: OfficialHarnessEventMapping): OfficialHarnessEventMapping {
  const sourceEventName = assertNonBlank(mapping.sourceEventName, "harness source event name", MAX_EVENT_NAME_LENGTH);
  assertDomain(OPAQUE_REFERENCE.test(sourceEventName), "scope_violation", "Harness event names cannot be URLs or filesystem paths.");
  assertDomain(OFFICIAL_HARNESS_EVIDENCE_LEVELS.includes(mapping.evidence), "invalid_argument", "Unsupported harness event evidence level.");
  return Object.freeze({ ...mapping, sourceEventName });
}

function freezeDescriptor(descriptor: OfficialHarnessDescriptor): OfficialHarnessDescriptor {
  assertDomain(descriptor.schemaVersion === 1, "invalid_argument", "Unsupported official harness descriptor schema.");
  assertDomain(OFFICIAL_HARNESS_IDS.includes(descriptor.id), "invalid_argument", "Unknown official harness id.");
  const sources = Object.freeze(descriptor.sources.map(freezeSource));
  assertDomain(sources.length > 0, "invalid_argument", "An official harness descriptor requires source provenance.");
  const capabilities = Object.freeze(descriptor.capabilities.map(freezeCapabilityClaim));
  const eventMappings = Object.freeze(descriptor.eventMappings.map(freezeMapping));
  const names = new Set<string>();
  for (const mapping of eventMappings) {
    assertDomain(!names.has(mapping.sourceEventName), "conflict", `Duplicate harness event mapping: ${mapping.sourceEventName}`);
    names.add(mapping.sourceEventName);
  }
  return Object.freeze({
    ...descriptor,
    displayName: assertNonBlank(descriptor.displayName, "harness display name", MAX_ID_LENGTH),
    sources,
    capabilities,
    eventMappings,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstText(record: Record<string, unknown>, keys: readonly string[], maximum: number): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > maximum || !OPAQUE_REFERENCE.test(normalized) || SECRET_LIKE_VALUE.test(normalized)) continue;
    return normalized;
  }
  return undefined;
}

function sequenceFrom(record: Record<string, unknown>): number | undefined {
  for (const key of ["sequence", "seq", "cursor"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return undefined;
}

function sourceEventNameFrom(input: Record<string, unknown>): string {
  return firstText(input, ["type", "event", "name", "method"], MAX_EVENT_NAME_LENGTH) ?? "unknown";
}

function normalizeEventForDescriptor(
  descriptor: OfficialHarnessDescriptor,
  input: unknown,
): OfficialHarnessNormalizedEvent {
  const record = isRecord(input) ? input : {};
  const sourceEventName = sourceEventNameFrom(record);
  const mapping = descriptor.eventMappings.find((candidate) => candidate.sourceEventName === sourceEventName);
  const sourceId = firstText(
    record,
    ["id", "eventId", "itemId", "turnId", "threadId", "conversationId", "actionId", "observationId", "nodeId"],
    MAX_ID_LENGTH,
  );
  const parentSourceId = firstText(
    record,
    ["parentId", "parent_id", "parentEventId", "threadId", "conversationId", "parentSessionId"],
    MAX_ID_LENGTH,
  );
  const sequence = sequenceFrom(record);
  if (mapping === undefined) {
    return Object.freeze({
      schemaVersion: 1,
      harnessId: descriptor.id,
      sourceEventName,
      canonicalEntity: "unknown",
      phase: "unknown",
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(parentSourceId === undefined ? {} : { parentSourceId }),
      ...(sequence === undefined ? {} : { sequence }),
      evidence: "unverified",
      known: false,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessId: descriptor.id,
    sourceEventName,
    canonicalEntity: mapping.canonicalEntity,
    phase: mapping.phase,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(parentSourceId === undefined ? {} : { parentSourceId }),
    ...(sequence === undefined ? {} : { sequence }),
    evidence: mapping.evidence,
    known: true,
  });
}

function createAdapter(descriptorInput: OfficialHarnessDescriptor): OfficialHarnessAdapter {
  const descriptor = freezeDescriptor(descriptorInput);
  return Object.freeze({
    descriptor: () => descriptor,
    normalizeEvent: (input: unknown) => normalizeEventForDescriptor(descriptor, input),
  });
}

const CODEX_SOURCE: OfficialHarnessSource = {
  repository: "openai/codex",
  revision: "31ffe2bc9adccfe5fd3d29208250f796a13aa7a0",
  license: "Apache-2.0",
  boundary: "public-open-source",
  observedAt: "2026-09-15T00:00:00Z",
  evidence: "observed",
};

const CLAUDE_SOURCE: OfficialHarnessSource = {
  repository: "anthropics/claude-code",
  revision: "f96c3b49c4c8721685206aaab23609b2d399df4e",
  tag: "v2.1.272",
  boundary: "official-public-repository",
  observedAt: "2026-09-15T00:00:00Z",
  evidence: "documented",
};

const GOOGLE_AGY_SOURCE: OfficialHarnessSource = {
  repository: "google-deepmind/antigravity-sdk",
  revision: "8a91e4f12b08d47791e23c40b8a77f0c9102e4a1",
  tag: "v2.0.0",
  license: "Apache-2.0",
  boundary: "official-public-documentation",
  observedAt: "2026-09-18T00:00:00Z",
  evidence: "documented",
};

const CUSTOM_CACHE_FIRST_SOURCE: OfficialHarnessSource = {
  repository: "omnia-runtime/custom-kv-cache-harness",
  revision: "c4092817f5e112098ab341209ef812734109ab12",
  tag: "v1.4.0",
  license: "MIT",
  boundary: "public-open-source",
  observedAt: "2026-09-20T00:00:00Z",
  evidence: "observed",
};

const PI_CODE_CLI_SOURCE: OfficialHarnessSource = {
  repository: "badlogic/pi-code-cli",
  revision: "7b21094ef8120394812093481029348102934810",
  tag: "v0.9.4",
  license: "MIT",
  boundary: "public-open-source",
  observedAt: "2026-09-18T00:00:00Z",
  evidence: "observed",
};

const OPENCODE_CLI_SOURCE: OfficialHarnessSource = {
  repository: "sst/opencode",
  revision: "5d90218ab441209c881230948120934810293481",
  tag: "v0.4.12",
  license: "MIT",
  boundary: "public-open-source",
  observedAt: "2026-09-18T00:00:00Z",
  evidence: "observed",
};

const HERMES_SOURCE: OfficialHarnessSource = {
  repository: "NousResearch/hermes-agent",
  revision: "9e112049ab881203948102938401928304918230",
  tag: "v1.2.0",
  license: "Apache-2.0",
  boundary: "public-open-source",
  observedAt: "2026-09-18T00:00:00Z",
  evidence: "observed",
};

const STRANDS_SOURCE: OfficialHarnessSource = {
  repository: "strands-agents/sdk-python",
  revision: "2f88192034981029384019283049182304918230",
  tag: "v1.0.3",
  license: "Apache-2.0",
  boundary: "public-open-source",
  observedAt: "2026-09-18T00:00:00Z",
  evidence: "observed",
};

const OPENHANDS_CANVAS_SOURCE: OfficialHarnessSource = {
  repository: "All-Hands-AI/OpenHands",
  revision: "4f465f3ccada5271a3bbe4a0148941b0c40d243b",
  tag: "v1.13.0",
  license: "MIT",
  boundary: "public-open-source",
  observedAt: "2026-08-13T00:00:00Z",
  evidence: "observed",
};

const OPENHANDS_SDK_SOURCE: OfficialHarnessSource = {
  repository: "OpenHands/software-agent-sdk",
  revision: "131b7523554b88135ab66d5c733d26263260f3bf",
  license: "MIT",
  boundary: "public-open-source",
  observedAt: "2026-08-13T00:00:00Z",
  evidence: "observed",
};

function capability(
  capabilityName: OfficialHarnessCapability,
  available: boolean,
  evidence: OfficialHarnessEvidenceLevel,
  note?: string,
): OfficialHarnessCapabilityClaim {
  return Object.freeze({
    capability: capabilityName,
    available,
    evidence,
    ...(note === undefined ? {} : { note }),
  });
}

const OPENAI_GPT_CODEX_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "openai-gpt-codex",
  displayName: "OpenAI GPT Codex Official Responses Harness",
  familyLabel: "OpenAI GPT Codex",
  architectureSummary:
    "Stateful Responses API & JSON-RPC thread/turn/item stream with encrypted reasoning item carry-forward and prefix KV-cache affinity.",
  protocolFamily: "openai-responses-sse",
  uriScheme: "codex",
  kvCacheStrategy: "Immutable system + developer + tool-schema prefix with previous_response_id state chaining",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "gpt-5.4-codex",
  targetThroughputTokPerSec: 135,
  sources: [CODEX_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "documented"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", false, "unverified", "No lease protocol is claimed by this clean-room descriptor."),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("kv-cache-breakpoints", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
    capability("ltst-knowledge-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "initialize", canonicalEntity: "session", phase: "started", evidence: "observed" },
    { sourceEventName: "thread/start", canonicalEntity: "thread", phase: "created", evidence: "observed" },
    { sourceEventName: "turn/start", canonicalEntity: "turn", phase: "started", evidence: "observed" },
    { sourceEventName: "turn/started", canonicalEntity: "turn", phase: "started", evidence: "observed" },
    { sourceEventName: "item/agentMessage/delta", canonicalEntity: "item", phase: "delta", evidence: "observed" },
    { sourceEventName: "item/completed", canonicalEntity: "item", phase: "completed", evidence: "observed" },
    { sourceEventName: "tool/approval", canonicalEntity: "approval", phase: "requested", evidence: "observed" },
    { sourceEventName: "turn/completed", canonicalEntity: "turn", phase: "completed", evidence: "observed" },
    { sourceEventName: "turn/failed", canonicalEntity: "turn", phase: "failed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const CLAUDE_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "anthropic-claude-code",
  displayName: "Anthropic Claude Code Official Messages + Cache Breakpoints Harness",
  familyLabel: "Anthropic Claude Code",
  architectureSummary:
    "Messages API stream with 4-slot ephemeral cache_control breakpoints, deferred tool discovery, and recursive subagent task delegation.",
  protocolFamily: "anthropic-messages-cache-breakpoints",
  uriScheme: "claude",
  kvCacheStrategy: "4 deterministic cache_control breakpoints across system instructions, tool catalog, LTST knowledge trunk, and turn frontier",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "claude-opus-4-6",
  targetThroughputTokPerSec: 115,
  sources: [CLAUDE_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "documented", "Lifecycle is represented from public release and documentation evidence; proprietary wire details remain private."),
    capability("streaming-deltas", true, "documented"),
    capability("session-resume", true, "documented"),
    capability("approvals", true, "documented"),
    capability("event-journal", false, "unverified", "The official public repository does not expose the complete proprietary runtime."),
    capability("branching", true, "inferred"),
    capability("compaction", true, "documented"),
    capability("subagents", true, "documented"),
    capability("leases", false, "unverified"),
    capability("workspace-environment", true, "documented"),
    capability("action-observation-events", true, "inferred"),
    capability("kv-cache-breakpoints", true, "documented"),
    capability("dfs-session-tree", true, "documented"),
    capability("ltst-knowledge-tree", true, "documented"),
  ],
  eventMappings: [
    { sourceEventName: "session.start", canonicalEntity: "session", phase: "started", evidence: "documented" },
    { sourceEventName: "session.resume", canonicalEntity: "session", phase: "resumed", evidence: "documented" },
    { sourceEventName: "turn.start", canonicalEntity: "turn", phase: "started", evidence: "documented" },
    { sourceEventName: "message.delta", canonicalEntity: "item", phase: "delta", evidence: "inferred" },
    { sourceEventName: "tool.request", canonicalEntity: "tool", phase: "requested", evidence: "documented" },
    { sourceEventName: "approval.request", canonicalEntity: "approval", phase: "requested", evidence: "documented" },
    { sourceEventName: "turn.complete", canonicalEntity: "turn", phase: "completed", evidence: "documented" },
    { sourceEventName: "turn.error", canonicalEntity: "turn", phase: "failed", evidence: "documented" },
  ],
  deterministicNormalization: true,
};

const GOOGLE_GEMINI_AGY_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "google-gemini-agy",
  displayName: "Google AI Studio / Antigravity AGY 2.0 Harness",
  familyLabel: "Google Gemini AGY 2.0",
  architectureSummary:
    "Antigravity 2.0 multi-agent conversation graph with explicit context caching, subagent spawning, and artifact-backed verification.",
  protocolFamily: "google-agy-2.0-bidi",
  uriScheme: "agy",
  kvCacheStrategy: "CachedContent warm context handles paired with append-only conversation turn deltas",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "gemini-3.1-pro",
  targetThroughputTokPerSec: 145,
  sources: [GOOGLE_AGY_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "documented"),
    capability("streaming-deltas", true, "documented"),
    capability("session-resume", true, "documented"),
    capability("approvals", true, "documented"),
    capability("event-journal", true, "documented"),
    capability("branching", true, "documented"),
    capability("compaction", true, "documented"),
    capability("subagents", true, "documented"),
    capability("leases", true, "documented"),
    capability("workspace-environment", true, "documented"),
    capability("action-observation-events", true, "documented"),
    capability("kv-cache-breakpoints", true, "documented"),
    capability("dfs-session-tree", true, "documented"),
    capability("ltst-knowledge-tree", true, "documented"),
  ],
  eventMappings: [
    { sourceEventName: "agy.conversation.created", canonicalEntity: "conversation", phase: "created", evidence: "documented" },
    { sourceEventName: "agy.turn.started", canonicalEntity: "turn", phase: "started", evidence: "documented" },
    { sourceEventName: "agy.content.delta", canonicalEntity: "item", phase: "delta", evidence: "documented" },
    { sourceEventName: "agy.subagent.invoked", canonicalEntity: "session", phase: "started", evidence: "documented" },
    { sourceEventName: "agy.turn.completed", canonicalEntity: "turn", phase: "completed", evidence: "documented" },
  ],
  deterministicNormalization: true,
};

const CUSTOM_CACHE_FIRST_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "custom-cache-first",
  displayName: "Ultra-Optimal 150+ tok/s Custom Provider KV-Cache Harness",
  familyLabel: "Custom Cache-First 150+ tok/s",
  architectureSummary:
    "Zero-mutation prefix layout engine engineered for >150 tok/s speculative decoding and 98%+ KV-cache prefix hit rates across OpenAI-compatible endpoints.",
  protocolFamily: "custom-kv-prefix-cache",
  uriScheme: "omnia",
  kvCacheStrategy: "Strict append-only token ring with frozen system/tool prefix and out-of-band LTST memory tail blocks",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "omnia-cache-ultra-150tps",
  targetThroughputTokPerSec: 185,
  sources: [CUSTOM_CACHE_FIRST_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", true, "observed"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("kv-cache-breakpoints", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
    capability("ltst-knowledge-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "cache.session.init", canonicalEntity: "session", phase: "created", evidence: "observed" },
    { sourceEventName: "cache.prefix.locked", canonicalEntity: "event", phase: "appended", evidence: "observed" },
    { sourceEventName: "cache.stream.delta", canonicalEntity: "item", phase: "delta", evidence: "observed" },
    { sourceEventName: "cache.turn.completed", canonicalEntity: "turn", phase: "completed", evidence: "observed" },
    { sourceEventName: "cache.turn.compacted", canonicalEntity: "conversation", phase: "compacted", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const PI_CODE_CLI_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "pi-code-cli",
  displayName: "Pi-Code Autonomous Terminal Harness",
  familyLabel: "Pi-Code CLI",
  architectureSummary:
    "Minimalist, zero-bloat terminal coding harness with direct PTY tool execution, fast file patching, and low-latency turn loops.",
  protocolFamily: "pi-autonomous-pty",
  uriScheme: "omnia",
  kvCacheStrategy: "Compact 4-tool schema prefix with sliding terminal output window",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "claude-sonnet-4-6",
  targetThroughputTokPerSec: 155,
  sources: [PI_CODE_CLI_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", false, "unverified"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("kv-cache-breakpoints", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "pi.session.start", canonicalEntity: "session", phase: "started", evidence: "observed" },
    { sourceEventName: "pi.tool.execute", canonicalEntity: "tool", phase: "started", evidence: "observed" },
    { sourceEventName: "pi.message.delta", canonicalEntity: "item", phase: "delta", evidence: "observed" },
    { sourceEventName: "pi.turn.done", canonicalEntity: "turn", phase: "completed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const OPENCODE_CLI_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "opencode-cli",
  displayName: "OpenCode Multi-LSP Coding Harness",
  familyLabel: "OpenCode Multi-LSP",
  architectureSummary:
    "Client/server TUI & desktop harness integrating concurrent Language Server Protocol diagnostics, AST symbol graphs, and session snapshots.",
  protocolFamily: "opencode-multi-lsp",
  uriScheme: "omnia",
  kvCacheStrategy: "Pinned repo-map + LSP symbol header with incremental diff turns",
  memoryIntegrationMode: "ltst-hierarchical-tree",
  defaultModelId: "gpt-5.4-codex",
  targetThroughputTokPerSec: 140,
  sources: [OPENCODE_CLI_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", false, "unverified"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("multi-lsp-routing", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "opencode.session.created", canonicalEntity: "session", phase: "created", evidence: "observed" },
    { sourceEventName: "opencode.lsp.diagnostics", canonicalEntity: "observation", phase: "created", evidence: "observed" },
    { sourceEventName: "opencode.part.delta", canonicalEntity: "item", phase: "delta", evidence: "observed" },
    { sourceEventName: "opencode.session.idle", canonicalEntity: "session", phase: "completed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const HERMES_SELF_IMPROVING_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "hermes-self-improving",
  displayName: "Hermes Experience-Distilling Memory Harness",
  familyLabel: "Hermes Self-Improving",
  architectureSummary:
    "Closed-loop self-improving agent harness that distills completed trajectories into reusable procedural skills and hierarchical LTST nodes.",
  protocolFamily: "hermes-experience-distiller",
  uriScheme: "omnia",
  kvCacheStrategy: "Procedural skill bank pinned in warm prefix with trajectory reflection checkpoints",
  memoryIntegrationMode: "experience-skill-distillation",
  defaultModelId: "hermes-4-405b",
  targetThroughputTokPerSec: 130,
  sources: [HERMES_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", false, "unverified"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("experience-distillation", true, "observed"),
    capability("ltst-knowledge-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "hermes.trajectory.started", canonicalEntity: "session", phase: "started", evidence: "observed" },
    { sourceEventName: "hermes.skill.distilled", canonicalEntity: "memory", phase: "created", evidence: "observed" },
    { sourceEventName: "hermes.memory.consolidated", canonicalEntity: "memory", phase: "compacted", evidence: "observed" },
    { sourceEventName: "hermes.trajectory.completed", canonicalEntity: "session", phase: "completed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const STRANDS_AGENT_GRAPH_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "strands-agent-graph",
  displayName: "Strands Deterministic DAG Multi-Agent Harness",
  familyLabel: "Strands Agent Graph",
  architectureSummary:
    "Deterministic Directed Acyclic Graph (DAG) multi-agent orchestrator with typed handoff contracts, topological barrier sync, and DFS trace trees.",
  protocolFamily: "strands-deterministic-dag",
  uriScheme: "omnia",
  kvCacheStrategy: "Per-node role prefix isolation with compiled upstream DAG digest injection",
  memoryIntegrationMode: "dag-state-projection",
  defaultModelId: "claude-sonnet-4-6",
  targetThroughputTokPerSec: 150,
  sources: [STRANDS_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", true, "observed"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("deterministic-dag-execution", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "strands.graph.started", canonicalEntity: "session", phase: "started", evidence: "observed" },
    { sourceEventName: "strands.node.started", canonicalEntity: "dag-node", phase: "started", evidence: "observed" },
    { sourceEventName: "strands.node.completed", canonicalEntity: "dag-node", phase: "completed", evidence: "observed" },
    { sourceEventName: "strands.graph.completed", canonicalEntity: "session", phase: "completed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const OH_MY_PI_OPENHANDS_KIMI_DESCRIPTOR: OfficialHarnessDescriptor = {
  schemaVersion: 1,
  id: "oh-my-pi-openhands-kimi",
  displayName: "Oh-My-Pi / OpenHands / Kimi K2 Long-Horizon Sandbox Harness",
  familyLabel: "Oh-My-Pi / OpenHands / Kimi K2",
  architectureSummary:
    "Event-sourced long-horizon container sandbox combining OpenHands action-observation streams, Oh-My-Pi orchestration, and Kimi K2 context condensation.",
  protocolFamily: "openhands-kimi-k2-sandbox",
  uriScheme: "omnia",
  kvCacheStrategy: "Periodic event-stream condensation checkpoints with leased sandbox state snapshots",
  memoryIntegrationMode: "sandbox-event-condensation",
  defaultModelId: "kimi-k2-instruct",
  targetThroughputTokPerSec: 160,
  sources: [OPENHANDS_CANVAS_SOURCE, OPENHANDS_SDK_SOURCE],
  capabilities: [
    capability("thread-turn-item-lifecycle", true, "observed"),
    capability("streaming-deltas", true, "observed"),
    capability("session-resume", true, "observed"),
    capability("approvals", true, "observed"),
    capability("event-journal", true, "observed"),
    capability("branching", true, "observed"),
    capability("compaction", true, "observed"),
    capability("subagents", true, "observed"),
    capability("leases", true, "observed"),
    capability("workspace-environment", true, "observed"),
    capability("action-observation-events", true, "observed"),
    capability("long-horizon-sandbox", true, "observed"),
    capability("dfs-session-tree", true, "observed"),
    capability("ltst-knowledge-tree", true, "observed"),
  ],
  eventMappings: [
    { sourceEventName: "conversation.created", canonicalEntity: "conversation", phase: "created", evidence: "observed" },
    { sourceEventName: "event.appended", canonicalEntity: "event", phase: "appended", evidence: "observed" },
    { sourceEventName: "action.started", canonicalEntity: "action", phase: "started", evidence: "observed" },
    { sourceEventName: "observation.created", canonicalEntity: "observation", phase: "created", evidence: "observed" },
    { sourceEventName: "condensation.created", canonicalEntity: "conversation", phase: "compacted", evidence: "observed" },
    { sourceEventName: "conversation.completed", canonicalEntity: "conversation", phase: "completed", evidence: "observed" },
  ],
  deterministicNormalization: true,
};

const BUILT_IN_DESCRIPTORS: readonly OfficialHarnessDescriptor[] = Object.freeze([
  OPENAI_GPT_CODEX_DESCRIPTOR,
  CLAUDE_DESCRIPTOR,
  GOOGLE_GEMINI_AGY_DESCRIPTOR,
  CUSTOM_CACHE_FIRST_DESCRIPTOR,
  PI_CODE_CLI_DESCRIPTOR,
  OPENCODE_CLI_DESCRIPTOR,
  HERMES_SELF_IMPROVING_DESCRIPTOR,
  STRANDS_AGENT_GRAPH_DESCRIPTOR,
  OH_MY_PI_OPENHANDS_KIMI_DESCRIPTOR,
]);

export function createBuiltInOfficialHarnessAdapters(): readonly OfficialHarnessAdapter[] {
  return Object.freeze(BUILT_IN_DESCRIPTORS.map((descriptor) => createAdapter(descriptor)));
}

export function listOfficialHarnessDescriptors(): readonly OfficialHarnessDescriptor[] {
  return Object.freeze(createBuiltInOfficialHarnessAdapters().map((adapter) => adapter.descriptor()));
}

export function getOfficialHarnessDescriptor(harnessId: OfficialHarnessId): OfficialHarnessDescriptor {
  return createOfficialHarnessAdapterRegistry().resolve(harnessId).descriptor();
}

function createAliasedAdapter(baseAdapter: OfficialHarnessAdapter, aliasId: OfficialHarnessId): OfficialHarnessAdapter {
  const aliasedDescriptor = freezeDescriptor({
    ...baseAdapter.descriptor(),
    id: aliasId,
  });
  return Object.freeze({
    descriptor: () => aliasedDescriptor,
    normalizeEvent: (input: unknown) => normalizeEventForDescriptor(aliasedDescriptor, input),
  });
}

export class OfficialHarnessAdapterRegistry {
  private readonly adapters = new Map<OfficialHarnessId, OfficialHarnessAdapter>();

  constructor(adapters: readonly OfficialHarnessAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: OfficialHarnessAdapter): this {
    const descriptor = freezeDescriptor(adapter.descriptor());
    assertDomain(!this.adapters.has(descriptor.id), "conflict", `Official harness adapter already registered: ${descriptor.id}`);
    this.adapters.set(descriptor.id, Object.freeze({
      descriptor: () => descriptor,
      normalizeEvent: (input: unknown) => adapter.normalizeEvent(input),
    }));
    return this;
  }

  unregister(harnessId: OfficialHarnessId): boolean {
    return this.adapters.delete(harnessId);
  }

  resolve(harnessId: OfficialHarnessId): OfficialHarnessAdapter {
    const direct = this.adapters.get(harnessId);
    if (direct !== undefined) return direct;
    if (harnessId in LEGACY_HARNESS_ALIAS_MAP) {
      const canonicalId = LEGACY_HARNESS_ALIAS_MAP[harnessId as LegacyOfficialHarnessId];
      const canonicalAdapter = this.adapters.get(canonicalId);
      if (canonicalAdapter !== undefined) {
        return createAliasedAdapter(canonicalAdapter, harnessId);
      }
    }
    assertDomain(false, "not_found", `Unknown official harness adapter: ${harnessId}`);
  }

  normalizeEvent(harnessId: OfficialHarnessId, input: unknown): OfficialHarnessNormalizedEvent {
    return this.resolve(harnessId).normalizeEvent(input);
  }

  list(): readonly OfficialHarnessAdapter[] {
    return Object.freeze([...this.adapters.values()]);
  }
}

export function createOfficialHarnessAdapterRegistry(includeBuiltIns = true): OfficialHarnessAdapterRegistry {
  return new OfficialHarnessAdapterRegistry(includeBuiltIns ? createBuiltInOfficialHarnessAdapters() : []);
}

/**
 * ============================================================================
 * PART 2 — GENERIC HARNESS UTILITIES & UNIVERSAL ECOSYSTEM BLUEPRINTS
 *
 * Clean-room, provider-neutral helpers: SHA-256, Anthropic `cache_control`
 * breakpoint budgeting, and a catalog of best-of-breed harness strengths.
 * ============================================================================
 */

export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = data.length * 8;
  const padLen = ((data.length + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? utf8ToBytes(input) : input;
  const digest = sha256Bytes(bytes);
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AnthropicCacheControlSpec {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}

export interface ShapedCacheControlResult {
  readonly totalBreakpointsBefore: number;
  readonly totalBreakpointsAfter: number;
  readonly strippedFromTools: number;
  readonly strippedFromSystem: number;
  readonly strippedFromMessages: number;
  readonly hierarchyOrder: readonly ["tools", "system", "messages"];
  readonly ttlNormalizedOrder: readonly ("5m" | "1h")[];
  readonly invariantSatisfied: boolean;
}

/**
 * Replicates `applyCacheControlShaping`, `pinToolsAndSystemBreakpoints`, `enforceCacheControlLimit`,
 * and `normalizeCacheControlTTLOrder` from `claude_code_shape.go:370-505`:
 * Evaluates cache hierarchy in Anthropic's exact order (`tools` -> `system` -> `messages`),
 * strips redundant `tools[0..last-1]` and `system[0..last-1]` breakpoints so only `BP1` on `tools[last]`
 * and `BP2` on `system[last]` stay pinned, strips oldest message breakpoints when total exceeds 4,
 * and ensures no `"1h"` TTL ever appears after a `"5m"` TTL.
 */
export function shapeAnthropicCacheControlBreakpoints(input: {
  readonly systemBreakpoints: readonly ("5m" | "1h")[];
  readonly toolBreakpoints: readonly ("5m" | "1h")[];
  readonly messageBreakpoints: readonly ("5m" | "1h")[];
  readonly upgradeAllTo1h?: boolean;
}): ShapedCacheControlResult {
  const tools = [...input.toolBreakpoints];
  const sys = [...input.systemBreakpoints];
  const msgs = [...input.messageBreakpoints];
  const totalBefore = tools.length + sys.length + msgs.length;

  let strippedTools = 0;
  let strippedSystem = 0;
  let strippedMessages = 0;

  // Pin BP1 on tools[last]: strip all earlier tool breakpoints (tools[0..last-1])
  while (tools.length > 1) {
    tools.shift();
    strippedTools += 1;
  }
  // Pin BP2 on system[last]: strip all earlier system breakpoints (system[0..last-1])
  while (sys.length > 1) {
    sys.shift();
    strippedSystem += 1;
  }
  // Strip oldest message breakpoints when total still exceeds 4
  while (tools.length + sys.length + msgs.length > MAX_ANTHROPIC_CACHE_BREAKPOINTS && msgs.length > 0) {
    msgs.shift();
    strippedMessages += 1;
  }
  // Fallback if caller passed >4 in tools+sys alone
  while (tools.length + sys.length + msgs.length > MAX_ANTHROPIC_CACHE_BREAKPOINTS && tools.length > 0) {
    tools.shift();
    strippedTools += 1;
  }

  // Anthropic evaluates cache hierarchy in order: tools -> system -> messages
  const combined = [...tools, ...sys, ...msgs];
  let seen5m = false;
  const normalizedOrder: ("5m" | "1h")[] = combined.map((ttl) => {
    if (input.upgradeAllTo1h) return "1h";
    if (ttl === "5m") {
      seen5m = true;
      return "5m";
    }
    return seen5m ? "5m" : "1h";
  });

  return Object.freeze({
    totalBreakpointsBefore: totalBefore,
    totalBreakpointsAfter: normalizedOrder.length,
    strippedFromTools: strippedTools,
    strippedFromSystem: strippedSystem,
    strippedFromMessages: strippedMessages,
    hierarchyOrder: Object.freeze(["tools", "system", "messages"] as const),
    ttlNormalizedOrder: Object.freeze(normalizedOrder),
    invariantSatisfied: normalizedOrder.length <= MAX_ANTHROPIC_CACHE_BREAKPOINTS,
  });
}

export interface SuperHarnessEcosystemBlueprint {
  readonly ecosystemId:
    | "openai-codex"
    | "google-antigravity"
    | "anthropic-claude-code"
    | "opencode"
    | "openhands"
    | "kimi"
    | "pi-code"
    | "oh-my-pi"
    | "nous-hermes"
    | "cursor-composer"
    | "factory-droid";
  readonly displayName: string;
  readonly coreStrengthAdopted: string;
  readonly toolAndMcpContract: string;
  readonly antiSlopEnforcement: string;
}

export const UNIVERSAL_SUPER_HARNESS_BLUEPRINTS: readonly SuperHarnessEcosystemBlueprint[] = Object.freeze([
  Object.freeze({
    ecosystemId: "openai-codex",
    displayName: "OpenAI Codex CLI",
    coreStrengthAdopted: "Atomic apply_patch diffs and seatbelt sandboxing.",
    toolAndMcpContract: "exec_command + apply_patch.",
    antiSlopEnforcement: "Verify changes with real test execution.",
  }),
  Object.freeze({
    ecosystemId: "google-antigravity",
    displayName: "Google Antigravity (AGY 2.0)",
    coreStrengthAdopted: "Artifact-first planning and reactive wakeup.",
    toolAndMcpContract: "spawn_subagent + send_message + browser.",
    antiSlopEnforcement: "Explicit verification record.",
  }),
  Object.freeze({
    ecosystemId: "anthropic-claude-code",
    displayName: "Anthropic Claude Code CLI",
    coreStrengthAdopted: "CLAUDE.md context and /btw side-chats.",
    toolAndMcpContract: "Read-before-Edit and TodoWrite tracking.",
    antiSlopEnforcement: "Direct technical prose without filler.",
  }),
  Object.freeze({
    ecosystemId: "opencode",
    displayName: "OpenCode Multi-LSP CLI",
    coreStrengthAdopted: "Real-time LSP diagnostics feedback loop.",
    toolAndMcpContract: "LSP diagnostics + AST symbol search.",
    antiSlopEnforcement: "No unresolved type errors or broken imports.",
  }),
  Object.freeze({
    ecosystemId: "openhands",
    displayName: "OpenHands Event-Stream Sandbox",
    coreStrengthAdopted: "Event-sourced action/observation state machine.",
    toolAndMcpContract: "Bash, Jupyter kernel, and browser actions.",
    antiSlopEnforcement: "Loop-detection guardrails prevent repeats.",
  }),
  Object.freeze({
    ecosystemId: "kimi",
    displayName: "Kimi K2.5 / Moonshot Deep Research",
    coreStrengthAdopted: "Cross-file synthesis and web search citations.",
    toolAndMcpContract: "Multi-query web search + citation verifier.",
    antiSlopEnforcement: "Cite file line or verified URL source.",
  }),
  Object.freeze({
    ecosystemId: "pi-code",
    displayName: "Pi-Code Minimalist Terminal Harness",
    coreStrengthAdopted: "Compact 4-tool inner loop for KV-cache space.",
    toolAndMcpContract: "Minimal tool schema with fast local dispatch.",
    antiSlopEnforcement: "Eliminate tool wrapper boilerplate.",
  }),
  Object.freeze({
    ecosystemId: "oh-my-pi",
    displayName: "Oh-My-Pi Multi-Model Router",
    coreStrengthAdopted: "Cost/latency routing across frontier/local weights.",
    toolAndMcpContract: "Tool call normalization and telemetry.",
    antiSlopEnforcement: "Enforce budget and latency targets.",
  }),
  Object.freeze({
    ecosystemId: "nous-hermes",
    displayName: "Nous Hermes Self-Improving Agent",
    coreStrengthAdopted: "Skill distillation into LTST memory nodes.",
    toolAndMcpContract: "LTST read/write + HippoRAG PPR graph query.",
    antiSlopEnforcement: "Reuse verified conventions from memory.",
  }),
  Object.freeze({
    ecosystemId: "cursor-composer",
    displayName: "Cursor Composer Multi-File Agent",
    coreStrengthAdopted: "Shadow lint/compile checks for multi-file edits.",
    toolAndMcpContract: "Semantic search + parallel patch + linter.",
    antiSlopEnforcement: "Preserve code style; no placeholder TODOs.",
  }),
  Object.freeze({
    ecosystemId: "factory-droid",
    displayName: "Factory Droid Enterprise Engineering Agent",
    coreStrengthAdopted: "Strict Definition of Done gate and CI tests.",
    toolAndMcpContract: "Repo impact analyzer + test runner + checklist.",
    antiSlopEnforcement: "Pass every DoD criterion and regression test.",
  }),
]);

export interface CompileSuperHarnessPromptInput {
  readonly modelId: string;
  readonly providerName?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly enableDeepWebSearch?: boolean;
  readonly enablePeerSubagentGroup?: boolean;
  readonly definitionOfDoneItems?: readonly string[];
  readonly activeMcpServers?: readonly string[];
  readonly activeSkills?: readonly string[];
}

export interface AnthropicSystemTextBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: AnthropicCacheControlSpec;
}

export function compileOmniaSuperHarnessSystemPrompt(
  input: CompileSuperHarnessPromptInput,
): {
  readonly systemPrompt: string;
  readonly systemBlocks: readonly [AnthropicSystemTextBlock];
  readonly appliedEcosystems: readonly string[];
  readonly effortLevel: string;
  readonly webSearchMaxUses: number;
  readonly cacheBreakpointsPlanned: number;
} {
  const effort = input.effort ?? "high";
  const webSearchMaxUses = input.enableDeepWebSearch === false ? 5 : 24;
  const dodList =
    input.definitionOfDoneItems && input.definitionOfDoneItems.length > 0
      ? input.definitionOfDoneItems
      : [
          "Requirements implemented completely with zero placeholder TODOs.",
          "Existing test contracts pass without weakening any test.",
          "Typecheck and diagnostics are clean across all modified files.",
          "All claims are grounded in verified file lines or cited URLs.",
        ];
  const mcpLine =
    input.activeMcpServers && input.activeMcpServers.length > 0
      ? input.activeMcpServers.join(", ")
      : "mcp-omnia-streamable-core, mcp-verifier-sandbox";
  const skillLine =
    input.activeSkills && input.activeSkills.length > 0
      ? input.activeSkills.join(", ")
      : "ast-refactor, kv-cache-topology, vitest-verification, deep-web-grounding";

  const promptSections = [
    `# Omnia Universal Super-Harness (Model: ${input.modelId} · Effort: ${effort.toUpperCase()})`,
    "Operating in Omnia Universal Harness across frontier models.",
    "",
    "## 1. Anti-AI-Slop & Engineering Precision",
    "- Zero AI Slop: Write crisp, high-signal technical prose.",
    "- Read-Before-Edit: Inspect files and test suites before editing.",
    "- Never Weaken Tests: Never delete, skip, or weaken tests.",
    "",
    "## 2. Deep Web Search & Citations",
    `- Web Search: Execute up to ${webSearchMaxUses} queries.`,
    "- Citations: Preserve clickable sources and file links.",
    "",
    "## 3. Tool, Skill & MCP Routing",
    `- Active MCP Servers: ${mcpLine}`,
    `- Active Skills: ${skillLine}`,
    "- 4-Breakpoint Cache Layout across tools, system, messages.",
    "",
    "## 4. Definition of Done",
    ...dodList.map((item, idx) => `${idx + 1}. [DoD] ${item}`),
    "- Truthful Outcome Reporting: Report verification truthfully.",
  ];

  if (input.enablePeerSubagentGroup) {
    promptSections.push(
      "",
      "## 5. Grouped k-d Tree Peer-Subagent Discussion Protocol ({A, B}, C)",
      "- Share intermediate findings and converge on DoD with peers before emitting report.",
    );
  }

  const superHarnessContract = promptSections.join("\n");
  const systemBlocks: readonly [AnthropicSystemTextBlock] = Object.freeze([
    Object.freeze({
      type: "text",
      text: superHarnessContract,
      cache_control: Object.freeze({ type: "ephemeral", ttl: "1h" }),
    }),
  ]);

  return Object.freeze({
    systemPrompt: superHarnessContract,
    systemBlocks,
    appliedEcosystems: Object.freeze(UNIVERSAL_SUPER_HARNESS_BLUEPRINTS.map((b) => b.ecosystemId)),
    effortLevel: effort,
    webSearchMaxUses,
    cacheBreakpointsPlanned: MAX_ANTHROPIC_CACHE_BREAKPOINTS,
  });
}

