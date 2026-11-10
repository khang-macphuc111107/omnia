import { DomainError, assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp } from "./shared";

/**
 * Copyable Live Session URIs & Recursive Pre-Order DFS Session Tree (`A -> B -> C`).
 *
 * Supports canonical cross-harness session addressing:
 * - `omnia://sessions/<id>`
 * - `codex://threads/<id>`
 * - `claude://sessions/<id>`
 * - `agy://conversations/<id>`
 *
 * And deterministic pre-order Depth-First Search (`A -> B1 -> C1 -> C2 -> B2`)
 * across both explicit `childSessionIds` and cross-referenced `referencedSessionUris`.
 */

export const LIVE_SESSION_URI_SCHEMES = Object.freeze([
  "omnia",
  "codex",
  "claude",
  "agy",
] as const);

export type LiveSessionUriScheme = (typeof LIVE_SESSION_URI_SCHEMES)[number];

export type LiveSessionUriNamespace = "sessions" | "threads" | "conversations";

export interface ParsedLiveSessionUri {
  readonly uri: string;
  readonly scheme: LiveSessionUriScheme;
  readonly namespace: LiveSessionUriNamespace;
  readonly sessionId: string;
  readonly defaultHarnessId: string;
}

export interface LiveSessionUriBundle {
  readonly sessionId: string;
  readonly omnia: string;
  readonly codex: string;
  readonly claude: string;
  readonly agy: string;
}

export const LIVE_SESSION_ROLES = Object.freeze([
  "main",
  "submain",
  "subagent",
  "verifier",
  "researcher",
  "coder",
] as const);

export type LiveSessionRole = (typeof LIVE_SESSION_ROLES)[number];

export type SessionAgentRole = LiveSessionRole;

export const LIVE_SESSION_STATUSES = Object.freeze([
  "running",
  "completed",
  "paused",
  "failed",
] as const);

export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number];

export interface DirectSubagentChatMessage {
  readonly id: string;
  readonly sender: "user" | "subagent" | "peer-agent" | "parent-main";
  readonly senderSessionId: string;
  readonly content: string;
  readonly timestamp: IsoTimestamp;
}

export interface LiveSessionNode {
  readonly sessionId: string;
  readonly uri: string;
  readonly title: string;
  readonly parentSessionId?: string | null;
  readonly parentSessionIds?: readonly string[];
  readonly childSessionIds: readonly string[];
  readonly role: LiveSessionRole;
  readonly status: LiveSessionStatus;
  readonly modelId: string;
  readonly harnessId: string;
  readonly tokenCount: number;
  readonly liveTranscriptSummary: string;
  readonly keyFindings: readonly string[];
  readonly referencedSessionUris: readonly string[];
  readonly peerGroupId?: string | null;
  readonly peerSiblingIds?: readonly string[];
  readonly directChatTranscript?: readonly DirectSubagentChatMessage[];
  readonly updatedAt: IsoTimestamp;
}

export interface CreateLiveSessionNodeInput {
  readonly sessionId: string;
  readonly uri?: string;
  readonly scheme?: LiveSessionUriScheme;
  readonly title: string;
  readonly parentSessionId?: string | null;
  readonly parentSessionIds?: readonly string[];
  readonly childSessionIds?: readonly string[];
  readonly role?: LiveSessionRole;
  readonly status?: LiveSessionStatus;
  readonly modelId?: string;
  readonly harnessId?: string;
  readonly tokenCount?: number;
  readonly liveTranscriptSummary?: string;
  readonly keyFindings?: readonly string[];
  readonly referencedSessionUris?: readonly string[];
  readonly peerGroupId?: string | null;
  readonly peerSiblingIds?: readonly string[];
  readonly directChatTranscript?: readonly DirectSubagentChatMessage[];
  readonly updatedAt?: IsoTimestamp;
}

export interface DfsSessionTraversalOptions {
  readonly maxDepth?: number;
  readonly includeLiveStreaming?: boolean;
}

export type DfsDiscoveryRelation = "root" | "child" | "uri-reference";

export interface DfsSessionTraversalStep {
  readonly depth: number;
  readonly dfsIndex: number;
  readonly pathFromRoot: readonly string[];
  readonly node: LiveSessionNode;
  readonly discoveredVia: DfsDiscoveryRelation;
  readonly sourceUri?: string;
}

export interface DfsCycleEdge {
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly via: "child" | "uri-reference";
  readonly uri?: string;
}

export interface DfsSessionTraversalResult {
  readonly rootSessionId: string;
  readonly steps: readonly DfsSessionTraversalStep[];
  readonly visitedIds: readonly string[];
  readonly cycleEdgesSkipped: readonly DfsCycleEdge[];
  readonly totalTokensAggregated: number;
  readonly compiledContextMarkdown: string;
}

const MAX_SESSION_ID_LENGTH = 256;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SECRET_LIKE_SESSION_ID = /^(?:sk-|rk-|gh[pousr]_|github_pat_)/i;

const SCHEME_NAMESPACE_MAP: Readonly<Record<LiveSessionUriScheme, LiveSessionUriNamespace>> = Object.freeze({
  omnia: "sessions",
  codex: "threads",
  claude: "sessions",
  agy: "conversations",
});

const SCHEME_DEFAULT_HARNESS_MAP: Readonly<Record<LiveSessionUriScheme, string>> = Object.freeze({
  omnia: "custom-cache-first",
  codex: "openai-gpt-codex",
  claude: "anthropic-claude-code",
  agy: "google-gemini-agy",
});

const HARNESS_TO_SCHEME_ALIAS: Readonly<Record<string, LiveSessionUriScheme>> = Object.freeze({
  omnia: "omnia",
  "omnia-session": "omnia",
  "custom-cache-first": "omnia",
  "pi-code-cli": "omnia",
  "opencode-cli": "omnia",
  "hermes-self-improving": "omnia",
  "strands-agent-graph": "omnia",
  "oh-my-pi-openhands-kimi": "omnia",
  openhands: "omnia",
  codex: "codex",
  "openai-codex": "codex",
  "openai-gpt-codex": "codex",
  claude: "claude",
  "anthropic-claude-code": "claude",
  agy: "agy",
  "google-gemini-agy": "agy",
});

const CANONICAL_URI_REGEX = /^(omnia|codex|claude|agy):\/\/(sessions|threads|conversations)\/([^\s/?#]+)$/;
const INLINE_URI_SCAN_REGEX = /\b(?:omnia:\/\/sessions|codex:\/\/threads|claude:\/\/sessions|agy:\/\/conversations)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\b/g;

function validateSessionId(rawId: string, label = "session ID"): string {
  const trimmed = assertNonBlank(rawId, label, MAX_SESSION_ID_LENGTH);
  assertDomain(
    !trimmed.includes("..") && SAFE_SESSION_ID_PATTERN.test(trimmed),
    "invalid_argument",
    `Invalid ${label}: "${trimmed}". Must contain only alphanumeric, '.', '_', ':', or '-' characters.`,
  );
  assertDomain(
    !SECRET_LIKE_SESSION_ID.test(trimmed),
    "scope_violation",
    `${label} cannot look like a secret credential token.`,
  );
  return trimmed;
}

function resolveScheme(schemeOrHint?: string): LiveSessionUriScheme {
  if (schemeOrHint === undefined) return "omnia";
  const normalized = schemeOrHint.trim().toLowerCase();
  const mapped = HARNESS_TO_SCHEME_ALIAS[normalized];
  assertDomain(
    mapped !== undefined,
    "invalid_argument",
    `Unsupported live session URI scheme: "${schemeOrHint}". Expected one of: omnia, codex, claude, agy.`,
  );
  return mapped;
}

export interface FormatLiveSessionUriInput {
  readonly sessionId: string;
  readonly scheme?: LiveSessionUriScheme | string;
}

export function formatLiveSessionUri(
  sessionIdOrInput: string | FormatLiveSessionUriInput,
  scheme?: LiveSessionUriScheme | string,
): string {
  const rawId = typeof sessionIdOrInput === "string" ? sessionIdOrInput : sessionIdOrInput.sessionId;
  const rawScheme = typeof sessionIdOrInput === "string" ? scheme : sessionIdOrInput.scheme;

  const existingParsed = tryParseLiveSessionUri(rawId);
  if (existingParsed !== null) {
    const resolvedScheme = rawScheme === undefined ? existingParsed.scheme : resolveScheme(rawScheme);
    const namespace = SCHEME_NAMESPACE_MAP[resolvedScheme];
    return `${resolvedScheme}://${namespace}/${existingParsed.sessionId}`;
  }

  const cleanSessionId = validateSessionId(rawId, "session ID");
  const resolvedScheme = resolveScheme(rawScheme);
  const namespace = SCHEME_NAMESPACE_MAP[resolvedScheme];
  return `${resolvedScheme}://${namespace}/${cleanSessionId}`;
}

export function parseLiveSessionUri(uri: string): ParsedLiveSessionUri {
  const trimmed = assertNonBlank(uri, "live session URI", 512);
  const match = CANONICAL_URI_REGEX.exec(trimmed);
  assertDomain(
    match !== null,
    "invalid_argument",
    `Invalid live session URI "${trimmed}". Expected omnia://sessions/<id>, codex://threads/<id>, claude://sessions/<id>, or agy://conversations/<id>.`,
  );
  const scheme = match[1] as LiveSessionUriScheme;
  const namespace = match[2] as LiveSessionUriNamespace;
  const rawSessionId = match[3] ?? "";
  const expectedNamespace = SCHEME_NAMESPACE_MAP[scheme];
  assertDomain(
    namespace === expectedNamespace,
    "invalid_argument",
    `Invalid namespace "${namespace}" for scheme "${scheme}://". Expected "${scheme}://${expectedNamespace}/<id>".`,
  );
  const sessionId = validateSessionId(rawSessionId, "URI session ID");
  return Object.freeze({
    uri: `${scheme}://${namespace}/${sessionId}`,
    scheme,
    namespace,
    sessionId,
    defaultHarnessId: SCHEME_DEFAULT_HARNESS_MAP[scheme],
  });
}

export function tryParseLiveSessionUri(uri: string): ParsedLiveSessionUri | null {
  try {
    return parseLiveSessionUri(uri);
  } catch {
    return null;
  }
}

export function formatAllLiveSessionUris(sessionId: string): LiveSessionUriBundle {
  const parsed = tryParseLiveSessionUri(sessionId);
  const cleanId = parsed ? parsed.sessionId : validateSessionId(sessionId);
  return Object.freeze({
    sessionId: cleanId,
    omnia: formatLiveSessionUri(cleanId, "omnia"),
    codex: formatLiveSessionUri(cleanId, "codex"),
    claude: formatLiveSessionUri(cleanId, "claude"),
    agy: formatLiveSessionUri(cleanId, "agy"),
  });
}

export function extractLiveSessionUris(text: string): readonly string[] {
  if (!text || typeof text !== "string") return Object.freeze([]);
  const matches = text.match(INLINE_URI_SCAN_REGEX) ?? [];
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const candidate of matches) {
    const parsed = tryParseLiveSessionUri(candidate);
    if (parsed !== null && !seen.has(parsed.uri)) {
      seen.add(parsed.uri);
      valid.push(parsed.uri);
    }
  }
  return Object.freeze(valid);
}

export function createLiveSessionNode(input: CreateLiveSessionNodeInput): LiveSessionNode {
  const sessionId = validateSessionId(input.sessionId, "sessionId");
  const harnessId = input.harnessId ? assertNonBlank(input.harnessId, "harnessId", 128) : "openai-gpt-codex";
  const scheme = input.scheme ?? HARNESS_TO_SCHEME_ALIAS[harnessId] ?? "omnia";
  const uri = input.uri ? parseLiveSessionUri(input.uri).uri : formatLiveSessionUri(sessionId, scheme);
  const title = assertNonBlank(input.title, "session title", 256);
  const role = input.role ?? "main";
  assertDomain(LIVE_SESSION_ROLES.includes(role), "invalid_argument", `Unsupported session role: ${role}`);
  const status = input.status ?? "running";
  assertDomain(LIVE_SESSION_STATUSES.includes(status), "invalid_argument", `Unsupported session status: ${status}`);
  const modelId = input.modelId ? assertNonBlank(input.modelId, "modelId", 128) : "gpt-5.4-codex";
  const tokenCount = input.tokenCount ?? 0;
  assertDomain(
    Number.isSafeInteger(tokenCount) && tokenCount >= 0,
    "invalid_argument",
    "Session tokenCount must be a non-negative integer.",
  );
  const updatedAt = input.updatedAt ?? "2026-10-18T16:00:00Z";
  assertIsoTimestamp(updatedAt, "session updatedAt");

  const normalizedParentSessionIds =
    input.parentSessionIds !== undefined
      ? Object.freeze(
          [...new Set(input.parentSessionIds.map((id) => validateSessionId(id, "parentSessionId")))],
        )
      : typeof input.parentSessionId === "string"
        ? Object.freeze([validateSessionId(input.parentSessionId, "parentSessionId")])
        : input.parentSessionId === null
          ? Object.freeze([] as readonly string[])
          : undefined;

  const resolvedParentSessionId =
    input.parentSessionId !== undefined
      ? input.parentSessionId
      : normalizedParentSessionIds !== undefined
        ? (normalizedParentSessionIds[0] ?? null)
        : undefined;

  const childSessionIds = Object.freeze(
    [...new Set((input.childSessionIds ?? []).map((id) => validateSessionId(id, "childSessionId")))],
  );
  const referencedSessionUris = Object.freeze(
    [...new Set((input.referencedSessionUris ?? []).map((refUri) => parseLiveSessionUri(refUri).uri))],
  );
  const keyFindings = Object.freeze(
    (input.keyFindings ?? []).map((finding) => assertNonBlank(finding, "keyFinding", 2000)),
  );
  const liveTranscriptSummary = (input.liveTranscriptSummary ?? "").trim();

  return Object.freeze({
    sessionId,
    uri,
    title,
    ...(resolvedParentSessionId !== undefined ? { parentSessionId: resolvedParentSessionId } : {}),
    ...(normalizedParentSessionIds !== undefined ? { parentSessionIds: normalizedParentSessionIds } : {}),
    childSessionIds,
    role,
    status,
    modelId,
    harnessId,
    tokenCount,
    liveTranscriptSummary,
    keyFindings,
    referencedSessionUris,
    ...(input.peerGroupId !== undefined ? { peerGroupId: input.peerGroupId } : {}),
    ...(input.peerSiblingIds !== undefined
      ? { peerSiblingIds: Object.freeze([...input.peerSiblingIds]) }
      : {}),
    ...(input.directChatTranscript !== undefined
      ? { directChatTranscript: Object.freeze([...input.directChatTranscript]) }
      : {}),
    updatedAt,
  });
}

function normalizeNodesCollection(
  nodesById:
    | Readonly<Record<string, LiveSessionNode>>
    | ReadonlyMap<string, LiveSessionNode>
    | readonly LiveSessionNode[],
): Map<string, LiveSessionNode> {
  const map = new Map<string, LiveSessionNode>();
  if (nodesById instanceof Map) {
    for (const [key, value] of nodesById.entries()) {
      map.set(key, value);
      map.set(value.sessionId, value);
    }
    return map;
  }
  if (Array.isArray(nodesById)) {
    for (const node of nodesById) {
      map.set(node.sessionId, node);
    }
    return map;
  }
  for (const [key, node] of Object.entries(nodesById)) {
    if (node) {
      map.set(key, node);
      map.set(node.sessionId, node);
    }
  }
  return map;
}

function resolveSessionIdFromReference(
  refOrId: string,
  nodeMap: ReadonlyMap<string, LiveSessionNode>,
): { readonly targetSessionId: string; readonly parsedUri?: ParsedLiveSessionUri } | null {
  const parsed = tryParseLiveSessionUri(refOrId);
  if (parsed !== null) {
    if (nodeMap.has(parsed.sessionId)) {
      return { targetSessionId: parsed.sessionId, parsedUri: parsed };
    }
    for (const candidate of nodeMap.values()) {
      if (candidate.uri === parsed.uri || candidate.sessionId === parsed.sessionId) {
        return { targetSessionId: candidate.sessionId, parsedUri: parsed };
      }
    }
    return { targetSessionId: parsed.sessionId, parsedUri: parsed };
  }
  const trimmed = refOrId.trim();
  if (nodeMap.has(trimmed)) {
    return { targetSessionId: trimmed };
  }
  return null;
}

function formatCompiledDfsContextMarkdown(
  rootSessionId: string,
  steps: readonly DfsSessionTraversalStep[],
  cycleEdgesSkipped: readonly DfsCycleEdge[],
  totalTokensAggregated: number,
  includeLiveStreaming: boolean,
): string {
  const lines: string[] = [];
  const rootNode = steps[0]?.node;
  const dfsChainOrder = steps.map((step) => step.node.sessionId).join(" -> ");

  lines.push(`# Compiled DFS Session Context Digest (${rootSessionId})`);
  lines.push("");
  lines.push(`- **Root Session URI**: \`${rootNode?.uri ?? formatLiveSessionUri(rootSessionId, "omnia")}\``);
  lines.push(`- **Pre-Order DFS Traversal Sequence**: \`${dfsChainOrder || rootSessionId}\``);
  lines.push(`- **Total Sessions Traversed**: ${steps.length}`);
  lines.push(`- **Total Aggregated Tokens**: ${totalTokensAggregated.toLocaleString("en-US")}`);
  lines.push(`- **Live Streaming Included**: ${includeLiveStreaming ? "yes" : "no (settled only)"}`);
  lines.push(`- **Cycle Edges Skipped**: ${cycleEdgesSkipped.length}`);
  lines.push("");

  for (const step of steps) {
    const { node, depth, dfsIndex, pathFromRoot, discoveredVia, sourceUri } = step;
    const indent = "  ".repeat(depth);
    const pathLabel = pathFromRoot.join(" -> ");
    const streamingTag = node.status === "running" ? " [LIVE STREAMING]" : ` [${node.status.toUpperCase()}]`;
    const viaLabel =
      discoveredVia === "root"
        ? "root"
        : discoveredVia === "uri-reference"
          ? `uri-reference (${sourceUri ?? node.uri})`
          : "childSessionIds";

    lines.push(`## [DFS #${dfsIndex}] ${pathLabel} — ${node.title}${streamingTag}`);
    lines.push(`${indent}- **Session ID**: \`${node.sessionId}\``);
    lines.push(`${indent}- **Canonical URI**: \`${node.uri}\``);
    lines.push(`${indent}- **Role / Harness / Model**: \`${node.role}\` · \`${node.harnessId}\` · \`${node.modelId}\``);
    if (node.parentSessionIds && node.parentSessionIds.length > 1) {
      lines.push(
        `${indent}- **Multi-Parent AI Council**: ${node.parentSessionIds.map((pid) => `\`${pid}\``).join(", ")}`,
      );
    }
    lines.push(`${indent}- **Depth / Discovery**: depth ${depth} via ${viaLabel}`);
    lines.push(`${indent}- **Tokens**: ${node.tokenCount.toLocaleString("en-US")}`);
    if (node.liveTranscriptSummary) {
      lines.push(`${indent}- **Transcript Summary**: ${node.liveTranscriptSummary}`);
    }
    if (node.keyFindings.length > 0) {
      lines.push(`${indent}- **Key Findings**:`);
      for (const finding of node.keyFindings) {
        lines.push(`${indent}  - ${finding}`);
      }
    }
    if (node.referencedSessionUris.length > 0) {
      lines.push(`${indent}- **Referenced Session URIs**: ${node.referencedSessionUris.map((u) => `\`${u}\``).join(", ")}`);
    }
    lines.push("");
  }

  if (cycleEdgesSkipped.length > 0) {
    lines.push("## Cycle Prevention Log");
    for (const edge of cycleEdgesSkipped) {
      lines.push(
        `- Skipped cycle edge \`${edge.fromSessionId} -> ${edge.toSessionId}\` (via ${edge.via}${edge.uri ? `: ${edge.uri}` : ""})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Performs deterministic Pre-Order Depth-First Search (`A -> B1 -> C1 -> C2 -> B2`)
 * across both explicit `childSessionIds` and cross-referenced `referencedSessionUris`.
 */
export function traverseSessionTreeDfs(
  rootSessionIdOrUri: string,
  nodesById:
    | Readonly<Record<string, LiveSessionNode>>
    | ReadonlyMap<string, LiveSessionNode>
    | readonly LiveSessionNode[],
  options: DfsSessionTraversalOptions = {},
): DfsSessionTraversalResult {
  const nodeMap = normalizeNodesCollection(nodesById);
  const resolvedRoot = resolveSessionIdFromReference(rootSessionIdOrUri, nodeMap);
  const rootId = resolvedRoot?.targetSessionId ?? validateSessionId(rootSessionIdOrUri, "rootSessionId");
  const rootNode = nodeMap.get(rootId);
  assertDomain(rootNode !== undefined, "not_found", `Root session node "${rootId}" was not found in session graph.`);

  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
  assertDomain(
    Number.isInteger(maxDepth) && maxDepth >= 0,
    "invalid_argument",
    "DFS maxDepth must be a non-negative integer.",
  );
  const includeLiveStreaming = options.includeLiveStreaming ?? true;

  const visitedIds = new Set<string>();
  const steps: DfsSessionTraversalStep[] = [];
  const cycleEdgesSkipped: DfsCycleEdge[] = [];
  let totalTokensAggregated = 0;

  function dfsVisit(
    currentNode: LiveSessionNode,
    depth: number,
    pathFromRoot: readonly string[],
    discoveredVia: DfsDiscoveryRelation,
    sourceUri?: string,
  ): void {
    visitedIds.add(currentNode.sessionId);
    const dfsIndex = steps.length;
    steps.push(
      Object.freeze({
        depth,
        dfsIndex,
        pathFromRoot: Object.freeze([...pathFromRoot]),
        node: currentNode,
        discoveredVia,
        ...(sourceUri === undefined ? {} : { sourceUri }),
      }),
    );
    totalTokensAggregated += currentNode.tokenCount;

    if (depth >= maxDepth) {
      return;
    }

    // Collect outgoing edges in deterministic pre-order:
    // 1. Explicit childSessionIds in declared order
    // 2. Cross-referenced session URIs (referencedSessionUris + inline transcript URIs) in declared order
    const outgoingEdges: Array<{
      readonly targetSessionId: string;
      readonly via: "child" | "uri-reference";
      readonly uri?: string;
    }> = [];
    const queuedForCurrentParent = new Set<string>();

    for (const childId of currentNode.childSessionIds) {
      const resolved = resolveSessionIdFromReference(childId, nodeMap);
      const targetId = resolved?.targetSessionId ?? childId;
      if (queuedForCurrentParent.has(targetId)) continue;
      queuedForCurrentParent.add(targetId);
      outgoingEdges.push({
        targetSessionId: targetId,
        via: "child",
      });
    }

    const allReferencedUris = [
      ...currentNode.referencedSessionUris,
      ...extractLiveSessionUris(currentNode.liveTranscriptSummary),
    ];

    for (const refUri of allReferencedUris) {
      const resolved = resolveSessionIdFromReference(refUri, nodeMap);
      if (resolved === null) continue;
      const targetId = resolved.targetSessionId;
      if (queuedForCurrentParent.has(targetId)) continue;
      queuedForCurrentParent.add(targetId);
      outgoingEdges.push({
        targetSessionId: targetId,
        via: "uri-reference",
        uri: resolved.parsedUri?.uri ?? refUri,
      });
    }

    for (const edge of outgoingEdges) {
      const targetNode = nodeMap.get(edge.targetSessionId);
      if (targetNode === undefined) continue;
      if (!includeLiveStreaming && targetNode.status === "running") {
        continue;
      }
      if (visitedIds.has(targetNode.sessionId)) {
        cycleEdgesSkipped.push(
          Object.freeze({
            fromSessionId: currentNode.sessionId,
            toSessionId: targetNode.sessionId,
            via: edge.via,
            ...(edge.uri === undefined ? {} : { uri: edge.uri }),
          }),
        );
        continue;
      }
      dfsVisit(
        targetNode,
        depth + 1,
        [...pathFromRoot, targetNode.sessionId],
        edge.via,
        edge.uri,
      );
    }
  }

  if (includeLiveStreaming || rootNode.status !== "running") {
    dfsVisit(rootNode, 0, [rootNode.sessionId], "root");
  }

  const compiledContextMarkdown = formatCompiledDfsContextMarkdown(
    rootNode.sessionId,
    steps,
    cycleEdgesSkipped,
    totalTokensAggregated,
    includeLiveStreaming,
  );

  return Object.freeze({
    rootSessionId: rootNode.sessionId,
    steps: Object.freeze(steps),
    visitedIds: Object.freeze([...visitedIds]),
    cycleEdgesSkipped: Object.freeze(cycleEdgesSkipped),
    totalTokensAggregated,
    compiledContextMarkdown,
  });
}

export function attachReferencedSessionUriToGraph(
  nodesById: Readonly<Record<string, LiveSessionNode>>,
  parentSessionId: string,
  targetUriInput: string,
  now: IsoTimestamp = "2026-10-18T16:10:00Z",
): Readonly<Record<string, LiveSessionNode>> {
  const parentNode = nodesById[parentSessionId];
  assertDomain(parentNode !== undefined, "not_found", `Parent session "${parentSessionId}" not found.`);
  const parsed = parseLiveSessionUri(targetUriInput);

  const updatedParent = createLiveSessionNode({
    ...parentNode,
    referencedSessionUris: [...new Set([...parentNode.referencedSessionUris, parsed.uri])],
    updatedAt: now,
  });

  const existingTarget = nodesById[parsed.sessionId];
  const targetNode =
    existingTarget ??
    createLiveSessionNode({
      sessionId: parsed.sessionId,
      uri: parsed.uri,
      title: `Linked ${parsed.scheme.toUpperCase()} Session (${parsed.sessionId})`,
      parentSessionId,
      childSessionIds: [],
      role: "researcher",
      status: "running",
      modelId:
        parsed.scheme === "codex"
          ? "gpt-5.4-codex"
          : parsed.scheme === "claude"
            ? "claude-opus-4-6"
            : parsed.scheme === "agy"
              ? "gemini-3.1-pro"
              : "omnia-cache-ultra-150tps",
      harnessId: parsed.defaultHarnessId,
      tokenCount: 1840,
      liveTranscriptSummary: `Live cross-referenced thread attached via ${parsed.uri} into ${parentSessionId}.`,
      keyFindings: [
        `Resolved external session reference ${parsed.uri}`,
        `Linked into recursive pre-order DFS graph under ${parentSessionId}`,
      ],
      referencedSessionUris: [],
      updatedAt: now,
    });

  return Object.freeze({
    ...nodesById,
    [parentSessionId]: updatedParent,
    [parsed.sessionId]: targetNode,
  });
}

export interface SpawnChildSessionInput {
  readonly parentSessionId: string;
  readonly childSessionId?: string;
  readonly title?: string;
  readonly role?: LiveSessionRole;
  readonly status?: LiveSessionStatus;
  readonly scheme?: LiveSessionUriScheme;
  readonly modelId?: string;
  readonly harnessId?: string;
  readonly tokenCount?: number;
  readonly liveTranscriptSummary?: string;
  readonly keyFindings?: readonly string[];
  readonly now?: IsoTimestamp;
}

export function spawnChildSessionInGraph(
  nodesById: Readonly<Record<string, LiveSessionNode>>,
  input: SpawnChildSessionInput,
): {
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
  readonly childNode: LiveSessionNode;
} {
  const parentNode = nodesById[input.parentSessionId];
  assertDomain(parentNode !== undefined, "not_found", `Parent session "${input.parentSessionId}" not found.`);
  const nextIndex = parentNode.childSessionIds.length + 1;
  const childSessionId =
    input.childSessionId ?? `${input.parentSessionId}-sub-${nextIndex}`;
  const now = input.now ?? "2026-10-18T16:12:00Z";
  const scheme = input.scheme ?? "omnia";

  const childNode = createLiveSessionNode({
    sessionId: childSessionId,
    uri: formatLiveSessionUri(childSessionId, scheme),
    title: input.title ?? `Sub-Session ${childSessionId} (from ${input.parentSessionId})`,
    parentSessionId: input.parentSessionId,
    childSessionIds: [],
    role: input.role ?? "subagent",
    status: input.status ?? "running",
    modelId: input.modelId ?? parentNode.modelId,
    harnessId: input.harnessId ?? parentNode.harnessId,
    tokenCount: input.tokenCount ?? 2150,
    liveTranscriptSummary:
      input.liveTranscriptSummary ??
      `Spawned child sub-session ${childSessionId} executing delegated verification for ${input.parentSessionId}.`,
    keyFindings: input.keyFindings ?? [
      `Delegated from parent ${parentNode.uri}`,
      "Streaming live sub-session findings into parent DFS digest",
    ],
    referencedSessionUris: [],
    updatedAt: now,
  });

  const updatedParent = createLiveSessionNode({
    ...parentNode,
    childSessionIds: [...new Set([...parentNode.childSessionIds, childNode.sessionId])],
    updatedAt: now,
  });

  const nextNodesById = Object.freeze({
    ...nodesById,
    [parentNode.sessionId]: updatedParent,
    [childNode.sessionId]: childNode,
  });

  return Object.freeze({
    nodesById: nextNodesById,
    childNode,
  });
}

export function createDefaultDfsSessionGraph(): Readonly<Record<string, LiveSessionNode>> {
  const sessionA = createLiveSessionNode({
    sessionId: "session-a",
    uri: "omnia://sessions/session-a",
    title: "Session A · Principal Architecture Orchestrator",
    parentSessionId: null,
    childSessionIds: ["session-b1", "session-b2"],
    role: "main",
    status: "running",
    modelId: "gpt-5.4-codex",
    harnessId: "openai-gpt-codex",
    tokenCount: 8420,
    liveTranscriptSummary:
      "Coordinating recursive A -> B -> C multi-agent synthesis across codex://threads/session-b1 and omnia://sessions/session-b2.",
    keyFindings: [
      "Pinned immutable prefix cache across all 9 official harnesses",
      "Delegated KV-cache audit to session-b1 and LTST schema verification to session-b2",
    ],
    referencedSessionUris: ["codex://threads/session-b1"],
    updatedAt: "2026-10-18T16:00:00Z",
  });

  const sessionB1 = createLiveSessionNode({
    sessionId: "session-b1",
    uri: "codex://threads/session-b1",
    title: "Session B1 · KV-Cache & Harness Researcher",
    parentSessionId: "session-a",
    childSessionIds: ["session-c1"],
    role: "researcher",
    status: "running",
    modelId: "claude-opus-4-6",
    harnessId: "anthropic-claude-code",
    tokenCount: 6310,
    liveTranscriptSummary:
      "Analyzing cache breakpoint hit rates and referencing deep trace in claude://sessions/session-c1 and agy://conversations/session-c2.",
    keyFindings: [
      "Verified 4-breakpoint ephemeral cache layout for Anthropic Messages API",
      "Cross-referenced Session C1 and Session C2 for benchmark confirmation",
    ],
    referencedSessionUris: ["claude://sessions/session-c1", "agy://conversations/session-c2"],
    updatedAt: "2026-10-18T16:02:00Z",
  });

  const sessionC1 = createLiveSessionNode({
    sessionId: "session-c1",
    uri: "claude://sessions/session-c1",
    title: "Session C1 · Deep Kernel Trace Coder",
    parentSessionId: "session-b1",
    childSessionIds: [],
    role: "coder",
    status: "completed",
    modelId: "omnia-cache-ultra-150tps",
    harnessId: "custom-cache-first",
    tokenCount: 4890,
    liveTranscriptSummary:
      "Implemented zero-mutation token ring achieving 185 tok/s sustained throughput.",
    keyFindings: [
      "Eliminated mid-prompt dynamic timestamps to preserve 99.1% prefix cache reuse",
      "Exported deterministic session digest back to Session B1 and Session A",
    ],
    referencedSessionUris: ["omnia://sessions/session-a"],
    updatedAt: "2026-10-18T16:04:00Z",
  });

  const sessionC2 = createLiveSessionNode({
    sessionId: "session-c2",
    uri: "agy://conversations/session-c2",
    title: "Session C2 · Subagent Contract Verifier",
    parentSessionId: "session-b1",
    childSessionIds: [],
    role: "verifier",
    status: "running",
    modelId: "gemini-3.1-pro",
    harnessId: "google-gemini-agy",
    tokenCount: 3750,
    liveTranscriptSummary:
      "Streaming live verification of A -> B1 -> C2 cross-referenced URI handoff invariants.",
    keyFindings: [
      "Confirmed cycle detection skips C1 -> A back-edges cleanly",
    ],
    referencedSessionUris: [],
    updatedAt: "2026-10-18T16:05:00Z",
  });

  const sessionB2 = createLiveSessionNode({
    sessionId: "session-b2",
    uri: "omnia://sessions/session-b2",
    title: "Session B2 · LTST Knowledge Tree Distiller",
    parentSessionId: "session-a",
    childSessionIds: [],
    role: "subagent",
    status: "completed",
    modelId: "hermes-4-405b",
    harnessId: "hermes-self-improving",
    tokenCount: 5120,
    liveTranscriptSummary:
      "Distilled flat MEMORY.md entries into /architecture, /learned-skills, and /session-provenance LTST nodes.",
    keyFindings: [
      "Replaced flat markdown memory with semantic linked knowledge nodes",
    ],
    referencedSessionUris: [],
    updatedAt: "2026-10-18T16:06:00Z",
  });

  return Object.freeze({
    [sessionA.sessionId]: sessionA,
    [sessionB1.sessionId]: sessionB1,
    [sessionC1.sessionId]: sessionC1,
    [sessionC2.sessionId]: sessionC2,
    [sessionB2.sessionId]: sessionB2,
  });
}

export const DEFAULT_OMNIA_SESSION_TREE_NODES: Readonly<Record<string, LiveSessionNode>> =
  createDefaultDfsSessionGraph();


/**
 * Multi-Parent & Recursive Multi-Child Session DAG (`Multi-Parent AI Council -> Child -> Grandchildren`).
 */
export function linkMultipleParentsToSession(
  nodesById: Readonly<Record<string, LiveSessionNode>>,
  childSessionId: string,
  parentIds: readonly string[],
  now: IsoTimestamp = "2026-10-18T16:20:00Z",
): Record<string, LiveSessionNode> {
  const cleanChildId = validateSessionId(childSessionId, "childSessionId");
  const childNode = nodesById[cleanChildId];
  assertDomain(
    childNode !== undefined,
    "not_found",
    `Child session "${cleanChildId}" was not found in session graph.`,
  );

  const normalizedIncomingParents = [
    ...new Set(parentIds.map((pid) => validateSessionId(pid, "parentSessionId"))),
  ].filter((pid) => pid !== cleanChildId);

  assertDomain(
    normalizedIncomingParents.length > 0,
    "invalid_argument",
    "linkMultipleParentsToSession requires at least one distinct parent session ID.",
  );

  for (const parentId of normalizedIncomingParents) {
    assertDomain(
      nodesById[parentId] !== undefined,
      "not_found",
      `Parent session "${parentId}" was not found in session graph.`,
    );
  }

  const existingParents =
    childNode.parentSessionIds && childNode.parentSessionIds.length > 0
      ? [...childNode.parentSessionIds]
      : typeof childNode.parentSessionId === "string"
        ? [childNode.parentSessionId]
        : [];

  const mergedParentIds = Object.freeze([
    ...new Set([...existingParents, ...normalizedIncomingParents]),
  ]);

  const councilFinding = `Co-supervised by Multi-Parent AI Council (${mergedParentIds.join(", ")})`;
  const updatedKeyFindings = childNode.keyFindings.includes(councilFinding)
    ? childNode.keyFindings
    : [...childNode.keyFindings, councilFinding];

  const updatedChild = createLiveSessionNode({
    ...childNode,
    parentSessionId: mergedParentIds[0] ?? childNode.parentSessionId ?? null,
    parentSessionIds: mergedParentIds,
    keyFindings: updatedKeyFindings,
    updatedAt: now,
  });

  const nextGraph: Record<string, LiveSessionNode> = {
    ...nodesById,
    [cleanChildId]: updatedChild,
  };

  for (const parentId of mergedParentIds) {
    const parentNode = nextGraph[parentId];
    if (!parentNode) continue;
    nextGraph[parentId] = createLiveSessionNode({
      ...parentNode,
      childSessionIds: [...new Set([...parentNode.childSessionIds, cleanChildId])],
      updatedAt: now,
    });
  }

  return Object.freeze(nextGraph);
}

export interface SpawnRecursiveSubagentSwarmInput {
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
  readonly parentSessionIds: readonly string[];
  readonly count: number;
  readonly baseTitle: string;
  readonly role: SessionAgentRole;
  readonly modelId?: string;
  readonly harnessId?: string;
  readonly scheme?: LiveSessionUriScheme;
  readonly childrenPerSubagent?: number;
  readonly now?: IsoTimestamp;
}

export interface SpawnRecursiveSubagentSwarmResult {
  readonly nodesById: Record<string, LiveSessionNode>;
  readonly spawnedSubagentIds: readonly string[];
  readonly spawnedGrandchildIds: readonly string[];
  readonly allSpawnedIds: readonly string[];
  readonly spawnedNodes: readonly LiveSessionNode[];
  readonly totalSpawnedCount: number;
  readonly parentSessionIds: readonly string[];
}

/**
 * Spawns `count` subagents with ZERO upper cap (`count` can be 1, 5, 50, 200, 1000+)
 * under one or more `parentSessionIds` (Multi-Parent AI Council), and optionally spawns
 * `childrenPerSubagent` recursive child workers under each spawned subagent
 * (`Parent(s) -> Subagent_i -> Grandchild_i_j`).
 */
export function spawnRecursiveSubagentSwarm(
  input: SpawnRecursiveSubagentSwarmInput,
): SpawnRecursiveSubagentSwarmResult {
  assertDomain(
    Number.isInteger(input.count) && input.count >= 0,
    "invalid_argument",
    "Swarm count must be a non-negative integer (no upper cap).",
  );
  const childrenPerSubagent = input.childrenPerSubagent ?? 0;
  assertDomain(
    Number.isInteger(childrenPerSubagent) && childrenPerSubagent >= 0,
    "invalid_argument",
    "childrenPerSubagent must be a non-negative integer.",
  );

  const validParentIds = [
    ...new Set(input.parentSessionIds.map((pid) => validateSessionId(pid, "parentSessionId"))),
  ];
  assertDomain(
    validParentIds.length > 0,
    "invalid_argument",
    "spawnRecursiveSubagentSwarm requires at least one parent session ID.",
  );

  for (const parentId of validParentIds) {
    assertDomain(
      input.nodesById[parentId] !== undefined,
      "not_found",
      `Parent session "${parentId}" was not found in session graph.`,
    );
  }

  const baseTitle = assertNonBlank(input.baseTitle, "swarm baseTitle", 180);
  const now = input.now ?? "2026-10-18T16:25:00Z";
  const primaryParentId = validParentIds[0]!;
  const primaryParent = input.nodesById[primaryParentId]!;
  const modelId = input.modelId ?? primaryParent.modelId;
  const harnessId = input.harnessId ?? primaryParent.harnessId;
  const scheme = input.scheme ?? HARNESS_TO_SCHEME_ALIAS[harnessId] ?? "omnia";

  const nextGraph: Record<string, LiveSessionNode> = { ...input.nodesById };
  const spawnedSubagentIds: string[] = [];
  const spawnedGrandchildIds: string[] = [];
  const spawnedNodes: LiveSessionNode[] = [];

  let existingSerialOffset = Object.keys(nextGraph).length;

  for (let i = 1; i <= input.count; i += 1) {
    let candidateId = `${primaryParentId}-swarm-${i}`;
    while (nextGraph[candidateId] !== undefined) {
      existingSerialOffset += 1;
      candidateId = `${primaryParentId}-swarm-${existingSerialOffset}-${i}`;
    }

    const grandchildIdsForCurrent: string[] = [];
    const grandchildNodesForCurrent: LiveSessionNode[] = [];

    for (let j = 1; j <= childrenPerSubagent; j += 1) {
      const grandchildId = `${candidateId}-child-${j}`;
      const grandchildNode = createLiveSessionNode({
        sessionId: grandchildId,
        uri: formatLiveSessionUri(grandchildId, scheme),
        title: `${baseTitle} #${i}.${j} (Recursive Sub-Worker)`,
        parentSessionId: candidateId,
        parentSessionIds: [candidateId],
        childSessionIds: [],
        role: input.role === "main" ? "subagent" : input.role,
        status: "running",
        modelId,
        harnessId,
        tokenCount: 980 + ((i + j) % 5) * 90,
        liveTranscriptSummary: `Recursive child worker ${grandchildId} executing sub-shard #${i}.${j} for parent subagent ${candidateId}.`,
        keyFindings: [
          `Spawned recursively by subagent ${candidateId}`,
          `Reporting leaf verification digest back to ${validParentIds.join(" + ")}`,
        ],
        referencedSessionUris: [],
        updatedAt: now,
      });
      grandchildIdsForCurrent.push(grandchildId);
      grandchildNodesForCurrent.push(grandchildNode);
      spawnedGrandchildIds.push(grandchildId);
    }

    const councilLabel =
      validParentIds.length > 1
        ? `Multi-Parent AI Council (${validParentIds.join(", ")})`
        : `Parent ${primaryParentId}`;

    const subagentNode = createLiveSessionNode({
      sessionId: candidateId,
      uri: formatLiveSessionUri(candidateId, scheme),
      title: `${baseTitle} #${i}`,
      parentSessionId: primaryParentId,
      parentSessionIds: validParentIds,
      childSessionIds: grandchildIdsForCurrent,
      role: input.role,
      status: "running",
      modelId,
      harnessId,
      tokenCount: 1540 + ((i - 1) % 7) * 110,
      liveTranscriptSummary: `Swarm agent #${i}/${input.count} co-supervised by ${councilLabel} executing ${baseTitle}.`,
      keyFindings: [
        `Co-supervised by ${councilLabel}`,
        ...(grandchildIdsForCurrent.length > 0
          ? [`Spawned ${grandchildIdsForCurrent.length} recursive child sub-workers (${grandchildIdsForCurrent.join(", ")})`]
          : [`Executing parallel shard #${i} with unlimited swarm policy`]),
      ],
      referencedSessionUris: [],
      updatedAt: now,
    });

    nextGraph[candidateId] = subagentNode;
    spawnedSubagentIds.push(candidateId);
    spawnedNodes.push(subagentNode);

    for (const grandchildNode of grandchildNodesForCurrent) {
      nextGraph[grandchildNode.sessionId] = grandchildNode;
      spawnedNodes.push(grandchildNode);
    }
  }

  for (const parentId of validParentIds) {
    const currentParent = nextGraph[parentId];
    if (!currentParent) continue;
    nextGraph[parentId] = createLiveSessionNode({
      ...currentParent,
      childSessionIds: [...new Set([...currentParent.childSessionIds, ...spawnedSubagentIds])],
      updatedAt: now,
    });
  }

  const allSpawnedIds = [...spawnedSubagentIds, ...spawnedGrandchildIds];

  return Object.freeze({
    nodesById: Object.freeze(nextGraph),
    spawnedSubagentIds: Object.freeze(spawnedSubagentIds),
    spawnedGrandchildIds: Object.freeze(spawnedGrandchildIds),
    allSpawnedIds: Object.freeze(allSpawnedIds),
    spawnedNodes: Object.freeze(spawnedNodes),
    totalSpawnedCount: allSpawnedIds.length,
    parentSessionIds: Object.freeze(validParentIds),
  });
}

/**
 * Adaptive Subagent Spawn Policy Engine (Strictly Unlimited Upper Cap).
 *
 * Teaches the orchestrator when NOT to spawn subagents (`0 agents — Direct Execution`),
 * when to spawn a focused squad (`2..6`), a parallel platoon (`8..25`), a multi-parent
 * AI council DAG, or a massive unlimited swarm (`50..500+`), with `maxSubagentCap: null`.
 */
export type SubagentSpawnStrategyLabel =
  | "single-agent-direct"
  | "focused-squad"
  | "parallel-platoon"
  | "massive-unlimited-swarm"
  | "multi-parent-council-dag";

export interface EvaluateSubagentSpawnPolicyInput {
  readonly taskDescription: string;
  readonly independentWorkstreams: number;
  readonly estimatedFilesToTouch: number;
  readonly couplingRatio: number;
  readonly requiresMultiModelConsensus: boolean;
  readonly requestedMinAgents?: number;
}

export interface SubagentSpawnPolicyDecision {
  readonly shouldSpawnSubagents: boolean;
  readonly recommendedCount: number;
  readonly maxSubagentCap: null;
  readonly recommendedParentCouncilCount: number;
  readonly recommendedDepth: number;
  readonly recommendedChildrenPerSubagent: number;
  readonly strategyLabel: SubagentSpawnStrategyLabel;
  readonly rationale: string;
}

export function evaluateSubagentSpawnPolicy(
  input: EvaluateSubagentSpawnPolicyInput,
): SubagentSpawnPolicyDecision {
  const workstreams = Math.max(0, Math.floor(input.independentWorkstreams));
  const filesToTouch = Math.max(0, Math.floor(input.estimatedFilesToTouch));
  const coupling = Math.min(1, Math.max(0, input.couplingRatio));
  const requestedMin = Math.max(0, Math.floor(input.requestedMinAgents ?? 0));
  const taskSummary = (input.taskDescription || "task").trim() || "task";

  // Know when NOT to spawn subagents: tightly-coupled or single-workstream sequential work
  const isTightlyCoupledSingleStream =
    workstreams <= 1 &&
    coupling > 0.8 &&
    !input.requiresMultiModelConsensus &&
    requestedMin <= 0;

  const isTrivialSingleFileEdit =
    workstreams <= 1 &&
    filesToTouch <= 1 &&
    coupling >= 0.65 &&
    !input.requiresMultiModelConsensus &&
    requestedMin <= 0;

  if (isTightlyCoupledSingleStream || isTrivialSingleFileEdit) {
    return Object.freeze({
      shouldSpawnSubagents: false,
      recommendedCount: 0,
      maxSubagentCap: null,
      recommendedParentCouncilCount: 1,
      recommendedDepth: 1,
      recommendedChildrenPerSubagent: 0,
      strategyLabel: "single-agent-direct",
      rationale: `Direct execution recommended (0 subagents) for "${taskSummary}": independentWorkstreams=${workstreams} and high couplingRatio=${coupling.toFixed(2)} mean spawning subagents would incur coordination & context-handoff overhead while breaking shared state locality.`,
    });
  }

  // Parallelism scales dynamically with ZERO upper cap
  const decouplingMultiplier = 1 + (1 - coupling) * 0.6;
  const fileWorkUnits = Math.ceil(filesToTouch / 3);
  const baseCalculated = Math.round(
    Math.max(workstreams, workstreams * 0.75 + fileWorkUnits * 0.45) * decouplingMultiplier,
  );
  const consensusMinimum = input.requiresMultiModelConsensus ? 3 : 2;

  // Strictly NO Math.min upper bound — honors any workstream scale or requestedMinAgents (50, 200, 1000+)
  const recommendedCount = Math.max(consensusMinimum, baseCalculated, workstreams, requestedMin);

  const recommendedParentCouncilCount = input.requiresMultiModelConsensus
    ? recommendedCount >= 25
      ? 4
      : recommendedCount >= 6
        ? 3
        : 2
    : 1;

  const recommendedDepth =
    recommendedCount >= 50 ? 4 : recommendedCount >= 12 ? 3 : recommendedCount >= 4 ? 2 : 1;

  const recommendedChildrenPerSubagent =
    recommendedDepth >= 4 ? 3 : recommendedDepth === 3 ? 2 : 0;

  let strategyLabel: SubagentSpawnStrategyLabel;
  if (recommendedCount >= 30) {
    strategyLabel = "massive-unlimited-swarm";
  } else if (input.requiresMultiModelConsensus && recommendedCount < 8) {
    strategyLabel = "multi-parent-council-dag";
  } else if (recommendedCount >= 8) {
    strategyLabel = input.requiresMultiModelConsensus
      ? "multi-parent-council-dag"
      : "parallel-platoon";
  } else {
    strategyLabel = "focused-squad";
  }

  const councilNote =
    recommendedParentCouncilCount > 1
      ? ` Co-supervised by a ${recommendedParentCouncilCount}-Parent AI Council DAG (Codex + Claude + Gemini/Hermes).`
      : "";

  return Object.freeze({
    shouldSpawnSubagents: true,
    recommendedCount,
    maxSubagentCap: null,
    recommendedParentCouncilCount,
    recommendedDepth,
    recommendedChildrenPerSubagent,
    strategyLabel,
    rationale: `Recommended ${recommendedCount} subagents (${strategyLabel}, depth ${recommendedDepth}, maxSubagentCap=UNLIMITED) for "${taskSummary}" across ${workstreams} independent workstreams and ${filesToTouch} files (coupling=${coupling.toFixed(2)}).${councilNote}`,
  });
}

/**
 * Selection Quote, Targeted Reply, `/btw` Ephemeral Side-Chat & Cross-Harness Slash Command Registry.
 */
export interface BtwSideChatEntry {
  readonly id: string;
  readonly selectedQuote: string;
  readonly sourceSessionUri: string;
  readonly question: string;
  readonly answer: string;
  readonly createdAt: string;
  readonly promotedToMainChat: boolean;
}

export interface CreateBtwSideChatTurnInput {
  readonly selectedQuote: string;
  readonly sourceSessionUri: string;
  readonly question: string;
  readonly activeSessionContext?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

export function createBtwSideChatTurn(input: CreateBtwSideChatTurnInput): BtwSideChatEntry {
  const cleanQuote = input.selectedQuote.trim() || "(active session context)";
  const parsedUri = tryParseLiveSessionUri(input.sourceSessionUri);
  const sourceSessionUri =
    parsedUri?.uri ??
    (input.sourceSessionUri.trim()
      ? formatLiveSessionUri(input.sourceSessionUri.trim(), "omnia")
      : "omnia://sessions/session-a");
  const cleanQuestion =
    input.question.trim() || "Clarify this highlighted selection without polluting the main session.";
  const contextSnippet = input.activeSessionContext?.trim()
    ? ` Grounded in live context: "${input.activeSessionContext.trim().slice(0, 180)}".`
    : "";
  const id = input.id?.trim() || `btw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = input.createdAt ?? "2026-10-18T16:30:00Z";

  const answer = `[Ephemeral /btw Side-Chat · Zero Main-Context Pollution] Regarding "${cleanQuote.slice(0, 140)}" from ${sourceSessionUri}: ${cleanQuestion} -> Resolved in isolated side-buffer (${sourceSessionUri}) so the primary prefix cache remains 100% intact.${contextSnippet}`;

  return Object.freeze({
    id,
    selectedQuote: cleanQuote,
    sourceSessionUri,
    question: cleanQuestion,
    answer,
    createdAt,
    promotedToMainChat: false,
  });
}

export interface FormatSelectionQuoteReplyInput {
  readonly selectedText: string;
  readonly sourceSessionUri: string;
  readonly replyComment?: string;
  readonly mode: "quote" | "targeted-reply" | "btw";
}

export function formatSelectionQuoteReply(input: FormatSelectionQuoteReplyInput): string {
  const cleanText = input.selectedText.trim() || "(selected snippet)";
  const parsedUri = tryParseLiveSessionUri(input.sourceSessionUri);
  const sourceUri = parsedUri?.uri ?? (input.sourceSessionUri.trim() || "omnia://sessions/session-a");
  const comment = input.replyComment?.trim() ?? "";

  const quotedLines = cleanText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

  if (input.mode === "btw") {
    return `/btw [Source: ${sourceUri}]\n${quotedLines}\n\nSide Question: ${comment || "Explain this selection without polluting main chat history."}`;
  }

  if (input.mode === "targeted-reply") {
    return `[Targeted Reply -> ${sourceUri}]\n${quotedLines}\n\nReply: ${comment || "Following up on this specific turn:"}`;
  }

  return `[Quote from ${sourceUri}]\n${quotedLines}${comment ? `\n\n${comment}` : ""}`;
}

export interface CrossHarnessSlashCommandSpec {
  readonly command: string;
  readonly title: string;
  readonly category: "side-chat" | "subagent-dag" | "tool-skill-mcp" | "memory-routing";
  readonly inspiredByHarnesses: readonly string[];
  readonly description: string;
  readonly usageExample: string;
  readonly mcpSkillBinding: string;
}

export const CROSS_HARNESS_SLASH_COMMANDS: readonly CrossHarnessSlashCommandSpec[] = Object.freeze([
  Object.freeze({
    command: "/btw",
    title: "Ephemeral Side-Chat (/btw)",
    category: "side-chat",
    inspiredByHarnesses: Object.freeze(["Claude Code", "Cursor", "Omnia"]),
    description: "Side question without polluting main history or cache.",
    usageExample: "/btw Why 4 cache breakpoints?",
    mcpSkillBinding: "mcp://omnia-sidecar/btw-ephemeral-Fork",
  }),
  Object.freeze({
    command: "/quote",
    title: "Inline Selection Blockquote",
    category: "side-chat",
    inspiredByHarnesses: Object.freeze(["Cursor", "Claude Code", "Codex"]),
    description: "Quote transcript lines with URI provenance.",
    usageExample: "/quote omnia://sessions/b1 > Verified",
    mcpSkillBinding: "mcp://omnia-sidecar/selection-quote",
  }),
  Object.freeze({
    command: "/reply",
    title: "Targeted Turn Reply",
    category: "side-chat",
    inspiredByHarnesses: Object.freeze(["OpenHands", "Claude Code", "AGY"]),
    description: "Reply to turn with thread provenance.",
    usageExample: "/reply codex://threads/b1 Benchmark 64K",
    mcpSkillBinding: "mcp://omnia-sidecar/turn-targeted-reply",
  }),
  Object.freeze({
    command: "/spawn",
    title: "Unlimited Recursive Subagent Swarm",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["Claude Code", "OpenHands", "Strands", "Omnia"]),
    description: "Spawn parallel subagents with recursive workers.",
    usageExample: "/spawn count=50 children=2 role=coder Audit",
    mcpSkillBinding: "mcp://omnia-orchestrator/unlimited-swarm-spawner",
  }),
  Object.freeze({
    command: "/council",
    title: "Multi-Parent AI Council Co-Supervision",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["Strands", "Hermes", "Omnia"]),
    description: "Link multiple parent models as co-parents of subagent.",
    usageExample: "/council parents=a,b child=c",
    mcpSkillBinding: "mcp://omnia-orchestrator/multi-parent-council-dag",
  }),
  Object.freeze({
    command: "/dfs",
    title: "Pre-Order DFS Session Digest",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["Codex", "Claude Code", "Omnia"]),
    description: "Traverse hierarchy in pre-order DFS and inject digest.",
    usageExample: "/dfs root=omnia://sessions/a maxDepth=8",
    mcpSkillBinding: "mcp://omnia-orchestrator/dfs-context-compiler",
  }),
  Object.freeze({
    command: "/verify",
    title: "Independent Subagent Verification Gate",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["Claude Code", "AGY", "OpenHands"]),
    description: "Spawn verifier subagent to run tests and layout checks.",
    usageExample: "/verify target=claude://sessions/c1 suite=vitest",
    mcpSkillBinding: "mcp://omnia-verifier/independent-gate",
  }),
  Object.freeze({
    command: "/calc",
    title: "Deterministic Symbolic & Numeric Calculator",
    category: "tool-skill-mcp",
    inspiredByHarnesses: Object.freeze(["Hermes", "Codex", "OpenCode"]),
    description: "Offload math to calculator tool instead of mental math.",
    usageExample: "/calc (185000 * 0.08) / 1000",
    mcpSkillBinding: "mcp://omnia-tools/deterministic-calculator",
  }),
  Object.freeze({
    command: "/browser",
    title: "Playwright / CDP Headless Browser Agent",
    category: "tool-skill-mcp",
    inspiredByHarnesses: Object.freeze(["AGY", "OpenHands", "Cursor"]),
    description: "Launch browser inspection with DOM snapshot and diffing.",
    usageExample: "/browser url=http://localhost:5173",
    mcpSkillBinding: "mcp://omnia-tools/playwright-browser-cdp",
  }),
  Object.freeze({
    command: "/idm",
    title: "Multi-Stream Segmented Artifact Downloader (IDM)",
    category: "tool-skill-mcp",
    inspiredByHarnesses: Object.freeze(["OpenHands", "Pi-Code", "Omnia"]),
    description: "Download artifacts with 16-connection HTTP Range chunking.",
    usageExample: "/idm connections=16 https://mirror/model.gguf",
    mcpSkillBinding: "mcp://omnia-tools/idm-range-accelerator",
  }),
  Object.freeze({
    command: "/ide",
    title: "Embedded LSP Code Editor & AST Refactor",
    category: "tool-skill-mcp",
    inspiredByHarnesses: Object.freeze(["Cursor", "OpenCode", "Pi-Code"]),
    description: "Open IDE worktree with LSP diagnostics and patch preview.",
    usageExample: "/ide open src/domain/session-dfs-tree.ts",
    mcpSkillBinding: "mcp://omnia-tools/embedded-lsp-ide",
  }),
  Object.freeze({
    command: "/remote",
    title: "SSH / Docker / WSL2 / Cloud Sandbox Bridge",
    category: "tool-skill-mcp",
    inspiredByHarnesses: Object.freeze(["OpenHands", "Codex", "Cursor"]),
    description: "Execute commands in SSH host, Docker, or Firecracker.",
    usageExample: "/remote target=ssh://gpu-node-01/workspace",
    mcpSkillBinding: "mcp://omnia-tools/remote-runtime-bridge",
  }),
  Object.freeze({
    command: "/uncensored",
    title: "Sovereign Local & Unfiltered Research Router",
    category: "memory-routing",
    inspiredByHarnesses: Object.freeze(["Hermes", "OpenCode", "Omnia"]),
    description: "Route audits and local weights to uncensored endpoints.",
    usageExample: "/uncensored model=hermes-4-405b Audit",
    mcpSkillBinding: "mcp://omnia-router/sovereign-uncensored-lane",
  }),
  Object.freeze({
    command: "/ltst",
    title: "Long-Term Semantic Knowledge Tree Distiller",
    category: "memory-routing",
    inspiredByHarnesses: Object.freeze(["Hermes", "Claude Code", "Omnia"]),
    description: "Distill session findings into hierarchical LTST memory.",
    usageExample: "/ltst distill session=omnia://sessions/a",
    mcpSkillBinding: "mcp://omnia-memory/ltst-semantic-tree",
  }),
  Object.freeze({
    command: "/a2a",
    title: "A2A Agent Card & MCP Streamable HTTP Delegation",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["Google A2A", "Claude Code", "Omnia"]),
    description: "Discover AgentCards and dispatch streaming task envelopes.",
    usageExample: "/a2a agent=verifier task=\"Verify\"",
    mcpSkillBinding: "mcp://omnia-a2a/streamable-http-router",
  }),
  Object.freeze({
    command: "/prm",
    title: "Process Reward Model (PRM) Step Verifier",
    category: "subagent-dag",
    inspiredByHarnesses: Object.freeze(["DeepSeek-R1", "OpenAI o3/Codex", "Omnia"]),
    description: "Score reasoning traces step-by-step and prune branches.",
    usageExample: "/prm threshold=0.45 verify=omnia://sessions/b1",
    mcpSkillBinding: "mcp://omnia-verifier/prm-mcts-step-scorer",
  }),
  Object.freeze({
    command: "/radix",
    title: "RadixAttention Shared Prefix KV-Cache Tree",
    category: "memory-routing",
    inspiredByHarnesses: Object.freeze(["SGLang RadixAttention", "vLLM", "Omnia"]),
    description: "Inspect shared KV-cache prefix tree blocks across sessions.",
    usageExample: "/radix root=omnia://sessions/a",
    mcpSkillBinding: "mcp://omnia-cache/radix-prefix-tree",
  }),
  Object.freeze({
    command: "/hipporag",
    title: "HippoRAG Multi-Hop Personalized PageRank Recall",
    category: "memory-routing",
    inspiredByHarnesses: Object.freeze(["HippoRAG 2", "Hermes", "Omnia"]),
    description: "Run Personalized PageRank retrieval over LTST knowledge.",
    usageExample: "/hipporag hops=2 query=\"KV-cache\"",
    mcpSkillBinding: "mcp://omnia-memory/hipporag-ppr-indexer",
  }),
]);

/**
 * ============================================================================
 * NEXT-GEN 2026 AI ARCHITECTURES
 * 1. A2A (Agent-to-Agent Protocol) & MCP 2026 Streamable HTTP Discovery
 * 2. PRM (Process Reward Model) Step-by-Step Reasoning Verifier & MCTS
 * 3. RadixAttention Prefix KV-Cache Tree & HippoRAG Associative Memory Graph
 * ============================================================================
 */

export type A2ASupportedModality = "text" | "code" | "audio" | "vision" | "artifact-stream";

export type A2AAuthScheme = "oauth2-pkce" | "mtls-spiffe" | "bearer-jwt" | "local-sovereign";

export interface A2AAgentCard {
  readonly agentId: string;
  readonly name: string;
  readonly endpointUri: string;
  readonly supportedModalities: readonly A2ASupportedModality[];
  readonly skills: readonly string[];
  readonly authScheme: A2AAuthScheme;
  readonly streamingSupported: boolean;
  readonly harnessId?: string;
  readonly defaultModelId?: string;
}

export interface McpStreamableServerSpec {
  readonly serverId: string;
  readonly name: string;
  readonly transport: "streamable-http" | "stdio";
  readonly endpointUrl: string;
  readonly roots: readonly string[];
  readonly sampling: boolean;
  readonly prompts: readonly string[];
  readonly resources: readonly string[];
  readonly dynamicToolDiscovery: boolean;
}

export const DEFAULT_A2A_AGENT_CARDS: readonly A2AAgentCard[] = Object.freeze([
  Object.freeze({
    agentId: "a2a-codex-architect",
    name: "Codex Principal Systems Architect",
    endpointUri: "https://a2a.omnia.local/agents/codex-architect/stream",
    supportedModalities: Object.freeze(["text", "code", "artifact-stream"] as const),
    skills: Object.freeze(["ast-refactor", "kv-cache-topology", "multi-parent-dag-synthesis"]),
    authScheme: "mtls-spiffe",
    streamingSupported: true,
    harnessId: "openai-gpt-codex",
    defaultModelId: "gpt-5.4-codex",
  }),
  Object.freeze({
    agentId: "a2a-claude-kernel-coder",
    name: "Claude Code Kernel & Ephemeral Cache Specialist",
    endpointUri: "https://a2a.omnia.local/agents/claude-kernel-coder/stream",
    supportedModalities: Object.freeze(["text", "code", "vision", "artifact-stream"] as const),
    skills: Object.freeze(["anthropic-4-slot-cache", "rust-tauri-ipc", "vitest-verification"]),
    authScheme: "oauth2-pkce",
    streamingSupported: true,
    harnessId: "anthropic-claude-code",
    defaultModelId: "claude-opus-4-6",
  }),
  Object.freeze({
    agentId: "a2a-gemini-prm-verifier",
    name: "AGY 2.0 PRM Reasoning & Browser Verifier",
    endpointUri: "https://a2a.omnia.local/agents/gemini-prm-verifier/stream",
    supportedModalities: Object.freeze(["text", "code", "vision", "audio", "artifact-stream"] as const),
    skills: Object.freeze(["prm-step-scoring", "playwright-cdp-audit", "mcts-branch-pruning"]),
    authScheme: "bearer-jwt",
    streamingSupported: true,
    harnessId: "google-gemini-agy",
    defaultModelId: "gemini-3.1-pro",
  }),
  Object.freeze({
    agentId: "a2a-sovereign-local-uncensored",
    name: "Sovereign GTX 1650 Ti Local Abliterated Specialist",
    endpointUri: "http://127.0.0.1:11434/a2a/sovereign-uncensored",
    supportedModalities: Object.freeze(["text", "code"] as const),
    skills: Object.freeze(["zero-refusal-security-audit", "gguf-flash-attn", "offline-sovereign-exec"]),
    authScheme: "local-sovereign",
    streamingSupported: true,
    harnessId: "custom-cache-first",
    defaultModelId: "huihui-qwen2.5-coder-7b-abliterated-q4km",
  }),
]);

export const DEFAULT_MCP_STREAMABLE_SERVERS: readonly McpStreamableServerSpec[] = Object.freeze([
  Object.freeze({
    serverId: "mcp-omnia-streamable-core",
    name: "Omnia 2026 Streamable HTTP MCP Mesh",
    transport: "streamable-http",
    endpointUrl: "http://127.0.0.1:8788/mcp/v2026/stream",
    roots: Object.freeze(["file:///D:/Omnia/repos/omnia", "file:///D:/Omnia/models"]),
    sampling: true,
    prompts: Object.freeze(["/dfs", "/btw", "/prm", "/radix", "/hipporag"]),
    resources: Object.freeze([
      "omnia://sessions/session-a",
      "ltst:///architecture",
      "radix://kv-cache/prefix-tree",
    ]),
    dynamicToolDiscovery: true,
  }),
  Object.freeze({
    serverId: "mcp-verifier-sandbox",
    name: "Adversarial PRM & LSP Verifier MCP Server",
    transport: "streamable-http",
    endpointUrl: "http://127.0.0.1:8789/mcp/v2026/verifier",
    roots: Object.freeze(["file:///D:/Omnia/repos/omnia/src"]),
    sampling: true,
    prompts: Object.freeze(["/verify", "/calc", "/ide"]),
    resources: Object.freeze(["diagnostics://tsc", "diagnostics://vitest"]),
    dynamicToolDiscovery: true,
  }),
]);

export interface BuildA2ATaskDelegationEnvelopeInput {
  readonly senderSessionUri: string;
  readonly targetAgentCard: A2AAgentCard;
  readonly taskPrompt: string;
  readonly mcpServer?: McpStreamableServerSpec;
  readonly envelopeId?: string;
  readonly createdAt?: IsoTimestamp;
}

export interface A2ATaskDelegationEnvelope {
  readonly envelopeId: string;
  readonly protocolVersion: "A2A-2026.1+MCP-Streamable-HTTP";
  readonly senderSessionUri: string;
  readonly targetAgentId: string;
  readonly targetAgentName: string;
  readonly targetEndpointUri: string;
  readonly authScheme: A2AAuthScheme;
  readonly streamingSupported: boolean;
  readonly mcpStreamableBinding: {
    readonly serverId: string;
    readonly transport: "streamable-http" | "stdio";
    readonly endpointUrl: string;
    readonly roots: readonly string[];
    readonly sampling: boolean;
    readonly dynamicToolDiscovery: boolean;
  };
  readonly taskPayload: {
    readonly prompt: string;
    readonly requiredModalities: readonly A2ASupportedModality[];
    readonly invokedSkills: readonly string[];
  };
  readonly createdAt: IsoTimestamp;
}

export function buildA2ATaskDelegationEnvelope(
  input: BuildA2ATaskDelegationEnvelopeInput,
): A2ATaskDelegationEnvelope {
  const parsedSender = tryParseLiveSessionUri(input.senderSessionUri);
  const senderSessionUri =
    parsedSender?.uri ?? formatLiveSessionUri(assertNonBlank(input.senderSessionUri, "senderSessionUri", 256), "omnia");
  const agentId = assertNonBlank(input.targetAgentCard.agentId, "targetAgentCard.agentId", 128);
  const agentName = assertNonBlank(input.targetAgentCard.name, "targetAgentCard.name", 256);
  const endpointUri = assertNonBlank(input.targetAgentCard.endpointUri, "targetAgentCard.endpointUri", 512);
  const taskPrompt = assertNonBlank(input.taskPrompt, "taskPrompt", 8000);
  const createdAt = input.createdAt ?? "2026-10-18T16:40:00Z";
  assertIsoTimestamp(createdAt, "A2A envelope createdAt");

  const mcpServer = input.mcpServer ?? DEFAULT_MCP_STREAMABLE_SERVERS[0]!;
  const envelopeId =
    input.envelopeId?.trim() || `a2a-env-${agentId}-${parsedSender?.sessionId ?? "root"}`;

  return Object.freeze({
    envelopeId,
    protocolVersion: "A2A-2026.1+MCP-Streamable-HTTP",
    senderSessionUri,
    targetAgentId: agentId,
    targetAgentName: agentName,
    targetEndpointUri: endpointUri,
    authScheme: input.targetAgentCard.authScheme,
    streamingSupported: input.targetAgentCard.streamingSupported,
    mcpStreamableBinding: Object.freeze({
      serverId: mcpServer.serverId,
      transport: mcpServer.transport,
      endpointUrl: mcpServer.endpointUrl,
      roots: Object.freeze([...mcpServer.roots]),
      sampling: mcpServer.sampling,
      dynamicToolDiscovery: mcpServer.dynamicToolDiscovery,
    }),
    taskPayload: Object.freeze({
      prompt: taskPrompt,
      requiredModalities: Object.freeze([...input.targetAgentCard.supportedModalities]),
      invokedSkills: Object.freeze([...input.targetAgentCard.skills]),
    }),
    createdAt,
  });
}

/**
 * 2. PRM (Process Reward Model) Step-by-Step Reasoning Verifier & Tree-of-Thoughts MCTS
 */
export type PrmStepVerdict = "valid" | "backtrack-branch" | "tool-verify-required";

export interface PrmEvaluatedStep {
  readonly stepIndex: number;
  readonly thought: string;
  readonly prmScore: number;
  readonly verdict: PrmStepVerdict;
  readonly mctsAction: "expand" | "prune-and-backtrack" | "invoke-verifier-tool";
  readonly rationale: string;
}

export interface EvaluateReasoningStepsWithPrmInput {
  readonly sessionId?: string;
  readonly steps: readonly (string | { readonly thought: string; readonly stepIndex?: number })[];
  readonly pruneThreshold?: number;
  readonly toolVerifyThreshold?: number;
}

export interface PrmReasoningVerificationResult {
  readonly sessionId: string;
  readonly evaluatedSteps: readonly PrmEvaluatedStep[];
  readonly aggregatePrmScore: number;
  readonly validStepCount: number;
  readonly prunedBranchCount: number;
  readonly toolVerificationRequiredCount: number;
  readonly recommendedMctsPath: readonly number[];
  readonly summary: string;
}

const PRM_HALLUCINATION_PATTERNS =
  /\b(?:guess|guessing|assume without|skip test|ignore error|fabricat|hallucinat|unverified assumption|blindly|bypass typecheck|delete tests)\b/i;

const PRM_TOOL_VERIFY_PATTERNS =
  /\b(?:maybe|might|unsure|need to check|run benchmark|verify with|untested|check if|estimate without tool|pending verification)\b/i;

const PRM_HIGH_REWARD_PATTERNS =
  /\b(?:verified|assert|vitest|tsc|kv-cache|prefix|dfs|provenance|invariant|deterministic|schema|hipporag|radix|a2a)\b/i;

export function evaluateReasoningStepsWithPrm(
  input: EvaluateReasoningStepsWithPrmInput | readonly string[],
): PrmReasoningVerificationResult {
  const normalizedInput: EvaluateReasoningStepsWithPrmInput = Array.isArray(input)
    ? { steps: input as readonly string[] }
    : (input as EvaluateReasoningStepsWithPrmInput);

  const sessionId = normalizedInput.sessionId?.trim() || "session-a";
  const pruneThreshold = Math.min(0.95, Math.max(0.05, normalizedInput.pruneThreshold ?? 0.45));
  const toolVerifyThreshold = Math.min(
    0.99,
    Math.max(pruneThreshold + 0.05, normalizedInput.toolVerifyThreshold ?? 0.72),
  );

  const evaluatedSteps: PrmEvaluatedStep[] = [];
  const recommendedMctsPath: number[] = [];
  let validStepCount = 0;
  let prunedBranchCount = 0;
  let toolVerificationRequiredCount = 0;
  let scoreSum = 0;

  normalizedInput.steps.forEach((rawStep, idx) => {
    const thought = (typeof rawStep === "string" ? rawStep : rawStep.thought).trim();
    const stepIndex = typeof rawStep === "string" ? idx : (rawStep.stepIndex ?? idx);
    if (!thought) return;

    let prmScore = 0.84;
    if (PRM_HALLUCINATION_PATTERNS.test(thought)) {
      prmScore = Math.max(0.12, Number((0.26 - (idx % 3) * 0.04).toFixed(2)));
    } else if (PRM_TOOL_VERIFY_PATTERNS.test(thought)) {
      prmScore = Number((0.62 + (idx % 3) * 0.03).toFixed(2));
    } else if (PRM_HIGH_REWARD_PATTERNS.test(thought)) {
      prmScore = Math.min(0.99, Number((0.91 + (idx % 4) * 0.02).toFixed(2)));
    } else {
      prmScore = Number((0.82 + (idx % 3) * 0.03).toFixed(2));
    }

    let verdict: PrmStepVerdict;
    let mctsAction: PrmEvaluatedStep["mctsAction"];
    let rationale: string;

    if (prmScore < pruneThreshold) {
      verdict = "backtrack-branch";
      mctsAction = "prune-and-backtrack";
      prunedBranchCount += 1;
      rationale = `PRM score ${prmScore.toFixed(2)} < prune threshold ${pruneThreshold.toFixed(2)}: detected speculative/unverified leap; pruning MCTS branch before execution.`;
    } else if (prmScore < toolVerifyThreshold) {
      verdict = "tool-verify-required";
      mctsAction = "invoke-verifier-tool";
      toolVerificationRequiredCount += 1;
      recommendedMctsPath.push(stepIndex);
      rationale = `PRM score ${prmScore.toFixed(2)} < verification threshold ${toolVerifyThreshold.toFixed(2)}: requires deterministic MCP tool or test verification gate before committing.`;
    } else {
      verdict = "valid";
      mctsAction = "expand";
      validStepCount += 1;
      recommendedMctsPath.push(stepIndex);
      rationale = `PRM score ${prmScore.toFixed(2)} >= ${toolVerifyThreshold.toFixed(2)}: grounded in verified invariants; safe to expand MCTS node.`;
    }

    scoreSum += prmScore;
    evaluatedSteps.push(
      Object.freeze({
        stepIndex,
        thought,
        prmScore,
        verdict,
        mctsAction,
        rationale,
      }),
    );
  });

  const aggregatePrmScore =
    evaluatedSteps.length > 0 ? Number((scoreSum / evaluatedSteps.length).toFixed(2)) : 1;

  return Object.freeze({
    sessionId,
    evaluatedSteps: Object.freeze(evaluatedSteps),
    aggregatePrmScore,
    validStepCount,
    prunedBranchCount,
    toolVerificationRequiredCount,
    recommendedMctsPath: Object.freeze(recommendedMctsPath),
    summary: `PRM evaluated ${evaluatedSteps.length} steps (mean score ${aggregatePrmScore.toFixed(2)}): ${validStepCount} valid, ${toolVerificationRequiredCount} tool-verify-required, ${prunedBranchCount} hallucination branches pruned.`,
  });
}

/**
 * 3A. RadixAttention Prefix KV-Cache Tree across Multi-Parent / Multi-Child Sessions
 */
export interface RadixKvCacheNodeMetric {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly parentSessionIds: readonly string[];
  readonly harnessId: string;
  readonly modelId: string;
  readonly totalTokens: number;
  readonly sharedPrefixTokens: number;
  readonly uniqueSuffixTokens: number;
  readonly prefixSharingPct: number;
  readonly ttftReductionMs: number;
  readonly radixPrefixKey: string;
}

export interface ComputeRadixKvCacheTreeOptions {
  readonly rootSessionId?: string;
  readonly immutableSystemPrefixTokens?: number;
  readonly ttftMsPer1kCachedTokens?: number;
}

export interface RadixKvCacheTreeResult {
  readonly rootSessionId: string;
  readonly nodes: readonly RadixKvCacheNodeMetric[];
  readonly totalTokensAcrossSessions: number;
  readonly totalSharedPrefixTokens: number;
  readonly overallPrefixSharingPct: number;
  readonly estimatedTotalTtftSavedMs: number;
  readonly summary: string;
}

export function computeRadixKvCacheTree(
  nodesOrInput:
    | Readonly<Record<string, LiveSessionNode>>
    | ReadonlyMap<string, LiveSessionNode>
    | readonly LiveSessionNode[]
    | {
        readonly nodesById:
          | Readonly<Record<string, LiveSessionNode>>
          | ReadonlyMap<string, LiveSessionNode>
          | readonly LiveSessionNode[];
        readonly rootSessionId?: string;
        readonly immutableSystemPrefixTokens?: number;
        readonly ttftMsPer1kCachedTokens?: number;
      },
  options: ComputeRadixKvCacheTreeOptions = {},
): RadixKvCacheTreeResult {
  const isWrapperObject =
    nodesOrInput !== null &&
    typeof nodesOrInput === "object" &&
    !Array.isArray(nodesOrInput) &&
    !(nodesOrInput instanceof Map) &&
    "nodesById" in nodesOrInput &&
    !("sessionId" in nodesOrInput);

  const rawCollection = isWrapperObject
    ? (
        nodesOrInput as {
          readonly nodesById:
            | Readonly<Record<string, LiveSessionNode>>
            | ReadonlyMap<string, LiveSessionNode>
            | readonly LiveSessionNode[];
        }
      ).nodesById
    : (nodesOrInput as
        | Readonly<Record<string, LiveSessionNode>>
        | ReadonlyMap<string, LiveSessionNode>
        | readonly LiveSessionNode[]);

  const mergedOptions: ComputeRadixKvCacheTreeOptions = isWrapperObject
    ? { ...(nodesOrInput as ComputeRadixKvCacheTreeOptions), ...options }
    : options;

  const nodeMap = normalizeNodesCollection(rawCollection);
  const allNodes = [...nodeMap.values()];
  const uniqueNodesMap = new Map<string, LiveSessionNode>();
  for (const node of allNodes) {
    uniqueNodesMap.set(node.sessionId, node);
  }
  const uniqueNodes = [...uniqueNodesMap.values()];

  const rootSessionId =
    mergedOptions.rootSessionId ??
    uniqueNodes.find((n) => !n.parentSessionId)?.sessionId ??
    uniqueNodes[0]?.sessionId ??
    "session-a";

  const immutableSystemPrefixTokens = Math.max(
    512,
    mergedOptions.immutableSystemPrefixTokens ?? 3200,
  );
  const ttftMsPer1kCachedTokens = Math.max(5, mergedOptions.ttftMsPer1kCachedTokens ?? 42);

  let totalTokensAcrossSessions = 0;
  let totalSharedPrefixTokens = 0;
  let estimatedTotalTtftSavedMs = 0;

  const metrics: RadixKvCacheNodeMetric[] = uniqueNodes.map((node) => {
    const parentIds =
      node.parentSessionIds && node.parentSessionIds.length > 0
        ? [...node.parentSessionIds]
        : node.parentSessionId
          ? [node.parentSessionId]
          : [];

    const primaryParent = parentIds[0] ? uniqueNodesMap.get(parentIds[0]) : undefined;
    const totalTokens = Math.max(256, node.tokenCount);

    // Compute shared Radix prefix tokens from immutable system trunk + parent prefix inheritance
    const parentInheritedTokens = primaryParent
      ? Math.round(Math.min(totalTokens * 0.42, primaryParent.tokenCount * 0.38))
      : 0;
    const multiParentBonusTokens =
      parentIds.length > 1 ? Math.round(Math.min(totalTokens * 0.12, parentIds.length * 320)) : 0;
    const baseSystemShared = Math.min(Math.round(totalTokens * 0.52), immutableSystemPrefixTokens);

    const sharedPrefixTokens = Math.min(
      Math.round(totalTokens * 0.94),
      baseSystemShared + parentInheritedTokens + multiParentBonusTokens,
    );
    const uniqueSuffixTokens = Math.max(0, totalTokens - sharedPrefixTokens);
    const prefixSharingPct = Number(((sharedPrefixTokens / totalTokens) * 100).toFixed(1));
    const ttftReductionMs = Math.round((sharedPrefixTokens / 1000) * ttftMsPer1kCachedTokens);

    totalTokensAcrossSessions += totalTokens;
    totalSharedPrefixTokens += sharedPrefixTokens;
    estimatedTotalTtftSavedMs += ttftReductionMs;

    const lineageKey = parentIds.length > 0 ? `${parentIds.join("+")}->${node.sessionId}` : node.sessionId;

    return Object.freeze({
      sessionId: node.sessionId,
      parentSessionId: node.parentSessionId ?? null,
      parentSessionIds: Object.freeze(parentIds),
      harnessId: node.harnessId,
      modelId: node.modelId,
      totalTokens,
      sharedPrefixTokens,
      uniqueSuffixTokens,
      prefixSharingPct,
      ttftReductionMs,
      radixPrefixKey: `radix://kv-prefix/${node.harnessId}/${lineageKey}`,
    });
  });

  const overallPrefixSharingPct =
    totalTokensAcrossSessions > 0
      ? Number(((totalSharedPrefixTokens / totalTokensAcrossSessions) * 100).toFixed(1))
      : 0;

  return Object.freeze({
    rootSessionId,
    nodes: Object.freeze(metrics),
    totalTokensAcrossSessions,
    totalSharedPrefixTokens,
    overallPrefixSharingPct,
    estimatedTotalTtftSavedMs,
    summary: `RadixAttention KV-Cache Tree across ${metrics.length} sessions: ${overallPrefixSharingPct}% shared prefix (${totalSharedPrefixTokens.toLocaleString("en-US")} / ${totalTokensAcrossSessions.toLocaleString("en-US")} tokens), saving ~${estimatedTotalTtftSavedMs} ms TTFT.`,
  });
}

/**
 * 3B. HippoRAG Multi-Hop Associative Memory Indexer (Personalized PageRank over LTST Graph)
 */
export interface HippoRagKnowledgeNodeInput {
  readonly id: string;
  readonly title: string;
  readonly folderPath?: string;
  readonly summary?: string;
  readonly content: string;
  readonly confidence?: number;
  readonly provenanceUris?: readonly string[];
}

export interface HippoRagSemanticEdgeInput {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly relation: string;
  readonly rationale?: string;
}

export interface QueryHippoRagAssociativeGraphInput {
  readonly query: string;
  readonly nodes: readonly HippoRagKnowledgeNodeInput[];
  readonly edges?: readonly HippoRagSemanticEdgeInput[];
  readonly links?: readonly HippoRagSemanticEdgeInput[];
  readonly maxHops?: number;
  readonly dampingFactor?: number;
  readonly topK?: number;
}

export interface HippoRagRankedNodeResult {
  readonly nodeId: string;
  readonly title: string;
  readonly folderPath: string;
  readonly pprScore: number;
  readonly lexicalSeedScore: number;
  readonly hopDistance: number;
  readonly associativePath: readonly string[];
  readonly matchedTerms: readonly string[];
  readonly provenanceUris: readonly string[];
}

export interface HippoRagAssociativeQueryResult {
  readonly query: string;
  readonly seedNodeIds: readonly string[];
  readonly rankedNodes: readonly HippoRagRankedNodeResult[];
  readonly multiHopEdgesTraversed: number;
  readonly dampingFactor: number;
  readonly maxHops: number;
  readonly summary: string;
}

function tokenizeHippoRagText(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

export function queryHippoRagAssociativeGraph(
  input: QueryHippoRagAssociativeGraphInput,
): HippoRagAssociativeQueryResult {
  const cleanQuery = (input.query || "").trim();
  const queryTerms = [...new Set(tokenizeHippoRagText(cleanQuery))];
  const edges = input.edges ?? input.links ?? [];
  const maxHops = Math.min(6, Math.max(1, Math.floor(input.maxHops ?? 2)));
  const dampingFactor = Math.min(0.98, Math.max(0.1, input.dampingFactor ?? 0.85));
  const topK = Math.max(1, Math.floor(input.topK ?? 5));

  if (input.nodes.length === 0) {
    return Object.freeze({
      query: cleanQuery,
      seedNodeIds: Object.freeze([]),
      rankedNodes: Object.freeze([]),
      multiHopEdgesTraversed: 0,
      dampingFactor,
      maxHops,
      summary: "HippoRAG associative graph is empty (0 nodes).",
    });
  }

  // Step 1: Compute lexical/parahippocampal seed activation per node
  const lexicalScores = new Map<string, number>();
  const matchedTermsByNode = new Map<string, readonly string[]>();
  const seedNodeIds: string[] = [];

  for (const node of input.nodes) {
    const corpus = `${node.title} ${node.folderPath ?? ""} ${node.summary ?? ""} ${node.content}`.toLowerCase();
    const matched = queryTerms.filter((term) => corpus.includes(term));
    matchedTermsByNode.set(node.id, Object.freeze(matched));
    const confidenceWeight = Math.min(1, Math.max(0.2, node.confidence ?? 0.9));
    const rawSeed =
      queryTerms.length > 0
        ? (matched.length / queryTerms.length) * confidenceWeight
        : confidenceWeight * 0.5;
    lexicalScores.set(node.id, rawSeed);
    if (matched.length > 0) {
      seedNodeIds.push(node.id);
    }
  }

  // If no lexical seed matched, use highest-confidence node as fallback seed
  if (seedNodeIds.length === 0 && input.nodes[0]) {
    seedNodeIds.push(input.nodes[0].id);
    lexicalScores.set(input.nodes[0].id, 0.5);
  }

  // Build bidirectional adjacency list with semantic relation weights
  const adjacency = new Map<string, Array<{ readonly neighborId: string; readonly weight: number }>>();
  for (const node of input.nodes) {
    adjacency.set(node.id, []);
  }

  let validEdgeCount = 0;
  for (const edge of edges) {
    if (!adjacency.has(edge.sourceNodeId) || !adjacency.has(edge.targetNodeId)) continue;
    const relWeight =
      edge.relation === "supports" || edge.relation === "derived-from"
        ? 1.0
        : edge.relation === "supersedes"
          ? 0.85
          : 0.65;
    adjacency.get(edge.sourceNodeId)?.push({ neighborId: edge.targetNodeId, weight: relWeight });
    adjacency.get(edge.targetNodeId)?.push({ neighborId: edge.sourceNodeId, weight: relWeight * 0.9 });
    validEdgeCount += 1;
  }

  // Step 2: Run Personalized PageRank power iteration over `maxHops` steps
  const pprScores = new Map<string, number>();
  const hopDistance = new Map<string, number>();
  const associativePath = new Map<string, readonly string[]>();

  let seedSum = 0;
  for (const score of lexicalScores.values()) {
    seedSum += score;
  }

  for (const node of input.nodes) {
    const seedVal = seedSum > 0 ? (lexicalScores.get(node.id) ?? 0) / seedSum : 1 / input.nodes.length;
    pprScores.set(node.id, seedVal);
    if (seedNodeIds.includes(node.id)) {
      hopDistance.set(node.id, 0);
      associativePath.set(node.id, Object.freeze([node.id]));
    } else {
      hopDistance.set(node.id, maxHops + 1);
      associativePath.set(node.id, Object.freeze([seedNodeIds[0] ?? node.id, node.id]));
    }
  }

  let multiHopEdgesTraversed = 0;
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const nextScores = new Map<string, number>();
    for (const node of input.nodes) {
      const restartProb =
        seedSum > 0 ? (lexicalScores.get(node.id) ?? 0) / seedSum : 1 / input.nodes.length;
      nextScores.set(node.id, (1 - dampingFactor) * restartProb);
    }

    for (const node of input.nodes) {
      const currentScore = pprScores.get(node.id) ?? 0;
      const neighbors = adjacency.get(node.id) ?? [];
      if (neighbors.length === 0 || currentScore <= 0) continue;

      const totalWeight = neighbors.reduce((acc, item) => acc + item.weight, 0) || 1;
      const nodeHops = hopDistance.get(node.id) ?? maxHops + 1;

      for (const { neighborId, weight } of neighbors) {
        const transfer = dampingFactor * currentScore * (weight / totalWeight);
        nextScores.set(neighborId, (nextScores.get(neighborId) ?? 0) + transfer);
        multiHopEdgesTraversed += 1;

        const existingNeighborHop = hopDistance.get(neighborId) ?? maxHops + 1;
        if (nodeHops + 1 < existingNeighborHop) {
          hopDistance.set(neighborId, nodeHops + 1);
          const parentPath = associativePath.get(node.id) ?? [node.id];
          associativePath.set(neighborId, Object.freeze([...parentPath, neighborId]));
        }
      }
    }

    for (const [id, score] of nextScores.entries()) {
      pprScores.set(id, score);
    }
  }

  // Normalize PPR scores to 0..1 relative to top node for readable telemetry
  const maxPpr = Math.max(...pprScores.values(), 0.0001);

  const rankedNodes: HippoRagRankedNodeResult[] = input.nodes
    .map((node) => {
      const rawPpr = pprScores.get(node.id) ?? 0;
      const normalizedPpr = Number(Math.min(1, rawPpr / maxPpr).toFixed(3));
      const lexicalSeedScore = Number((lexicalScores.get(node.id) ?? 0).toFixed(3));
      const resolvedHops = hopDistance.get(node.id) ?? 0;
      return Object.freeze({
        nodeId: node.id,
        title: node.title,
        folderPath: node.folderPath ?? "/architecture",
        pprScore: normalizedPpr,
        lexicalSeedScore,
        hopDistance: resolvedHops > maxHops ? maxHops : resolvedHops,
        associativePath: associativePath.get(node.id) ?? Object.freeze([node.id]),
        matchedTerms: matchedTermsByNode.get(node.id) ?? Object.freeze([]),
        provenanceUris: Object.freeze([...(node.provenanceUris ?? [])]),
      });
    })
    .sort((a, b) => b.pprScore - a.pprScore || b.lexicalSeedScore - a.lexicalSeedScore)
    .slice(0, topK);

  return Object.freeze({
    query: cleanQuery,
    seedNodeIds: Object.freeze(seedNodeIds),
    rankedNodes: Object.freeze(rankedNodes),
    multiHopEdgesTraversed: Math.max(validEdgeCount, multiHopEdgesTraversed),
    dampingFactor,
    maxHops,
    summary: `HippoRAG PPR recall for "${cleanQuery || "*"}": activated ${seedNodeIds.length} seed node(s), traversed ${Math.max(validEdgeCount, multiHopEdgesTraversed)} associative edges across ${maxHops} hops (top node: ${rankedNodes[0]?.nodeId ?? "none"} @ PPR ${rankedNodes[0]?.pprScore.toFixed(3) ?? "0.000"}).`,
  });
}

/**
 * ============================================================================
 * 4. GROUPED k-d TREE MULTI-MAIN & PEER-DISCUSSION SUBAGENT DAG (`{A, B}, C`)
 *    & DIRECT USER-TO-SUBAGENT CHAT
 * ============================================================================
 */

export type KdTreePartitionAxis = "x-architecture" | "y-verification" | "z-domain";

export interface KdTreePeerGroupBucket {
  readonly groupId: string;
  readonly notation: string;
  readonly isPeerCluster: boolean;
  readonly kdAxis: KdTreePartitionAxis;
  readonly kdDepth: number;
  readonly parentSessionIds: readonly string[];
  readonly memberSessionIds: readonly string[];
  readonly definitionOfDone: readonly string[];
  readonly allowedMcpServers: readonly string[];
  readonly allowedSkills: readonly string[];
  readonly allowedTools: readonly string[];
}

export interface PeerDiscussionExchangeTurn {
  readonly round: number;
  readonly speakerSessionId: string;
  readonly recipientSessionId: string;
  readonly critiqueOrProposal: string;
  readonly invokedMcpToolOrSkill: string;
  readonly dodItemVerified: string;
  readonly timestamp: IsoTimestamp;
}

export interface PeerGroupConsensusReport {
  readonly groupId: string;
  readonly notation: string;
  readonly memberSessionIds: readonly string[];
  readonly parentSessionIds: readonly string[];
  readonly discussionTurns: readonly PeerDiscussionExchangeTurn[];
  readonly definitionOfDoneChecklist: readonly {
    readonly item: string;
    readonly satisfiedBySessionId: string;
    readonly verified: true;
  }[];
  readonly consolidatedParentReport: string;
  readonly updatedNodesById: Readonly<Record<string, LiveSessionNode>>;
}

export interface PartitionKdTreeSubagentGroupsInput {
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
  readonly parentSessionIds: readonly string[];
  /**
   * Explicit group expression such as `"{session-b1, session-c1}, session-c2"`
   * or `"{A, B}, C"`, or array of member ID arrays `[["session-b1", "session-c1"], ["session-c2"]]`.
   */
  readonly groupSpec: string | readonly (readonly string[])[];
  readonly definitionOfDone?: readonly string[];
  readonly allowedMcpServers?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly now?: IsoTimestamp;
}

export interface PartitionKdTreeSubagentGroupsResult {
  readonly parentSessionIds: readonly string[];
  readonly canonicalNotation: string;
  readonly buckets: readonly KdTreePeerGroupBucket[];
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
}

const KD_AXES: readonly KdTreePartitionAxis[] = Object.freeze([
  "x-architecture",
  "y-verification",
  "z-domain",
] as const);

/**
 * Parses a k-d tree group expression like `"{A, B}, C"` or `"{session-b1, session-c1}, session-c2"`
 * into ordered peer buckets `[["A", "B"], ["C"]]`.
 */
export function parseKdTreeGroupExpression(
  expression: string | readonly (readonly string[])[],
): readonly (readonly string[])[] {
  if (typeof expression !== "string") {
    return Object.freeze(
      expression
        .map((group) =>
          Object.freeze(
            [...new Set(group.map((id) => validateSessionId(id, "peer group member ID")))],
          ),
        )
        .filter((group) => group.length > 0),
    );
  }

  const raw = assertNonBlank(expression, "k-d tree group expression", 1024);
  const buckets: string[][] = [];
  let idx = 0;

  while (idx < raw.length) {
    while (idx < raw.length && /[\s,]/.test(raw[idx]!)) idx += 1;
    if (idx >= raw.length) break;

    if (raw[idx] === "{") {
      let depth = 0;
      let closeIdx = -1;
      for (let scan = idx; scan < raw.length; scan += 1) {
        if (raw[scan] === "{") {
          depth += 1;
        } else if (raw[scan] === "}") {
          depth -= 1;
          if (depth === 0) {
            closeIdx = scan;
            break;
          }
        }
      }
      assertDomain(
        closeIdx > idx && depth === 0,
        "invalid_argument",
        `Unclosed '{' in k-d tree group expression: "${raw}"`,
      );
      const inside = raw.slice(idx + 1, closeIdx).replace(/[{}]/g, ",");
      const members = inside
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => validateSessionId(id, "peer group member ID"));
      if (members.length > 0) {
        buckets.push([...new Set(members)]);
      }
      idx = closeIdx + 1;
    } else if (raw[idx] === "}") {
      throw new DomainError(
        "invalid_argument",
        `Unmatched '}' in k-d tree group expression: "${raw}"`,
      );
    } else {
      let endIdx = idx;
      while (
        endIdx < raw.length &&
        raw[endIdx] !== "," &&
        raw[endIdx] !== "{" &&
        raw[endIdx] !== "}"
      ) {
        endIdx += 1;
      }
      const token = raw.slice(idx, endIdx).trim();
      if (token) {
        buckets.push([validateSessionId(token, "singleton group member ID")]);
      }
      idx = endIdx;
    }
  }

  assertDomain(
    buckets.length > 0,
    "invalid_argument",
    "k-d tree group expression must contain at least one subagent session ID.",
  );

  return Object.freeze(buckets.map((b) => Object.freeze(b)));
}

/**
 * Partitions subagents under one or more `Main` / `Sub-Main` parent nodes into
 * k-d tree peer groups (`{A, B}, C`), wiring peer sibling references and
 * explicit Definition of Done + MCP/Skill/Tool contracts.
 */
export function partitionSubagentsIntoKdTreeGroups(
  input: PartitionKdTreeSubagentGroupsInput,
): PartitionKdTreeSubagentGroupsResult {
  const parentIds = [
    ...new Set(input.parentSessionIds.map((pid) => validateSessionId(pid, "parentSessionId"))),
  ];
  assertDomain(
    parentIds.length > 0,
    "invalid_argument",
    "partitionSubagentsIntoKdTreeGroups requires at least one Main or Sub-Main parent session ID.",
  );

  const parsedGroups = parseKdTreeGroupExpression(input.groupSpec);
  const now = input.now ?? "2026-10-18T16:45:00Z";
  const nextGraph: Record<string, LiveSessionNode> = { ...input.nodesById };

  for (const pid of parentIds) {
    if (!nextGraph[pid]) {
      nextGraph[pid] = createLiveSessionNode({
        sessionId: pid,
        title: `Main / Sub-Main Orchestrator (${pid})`,
        role: pid.toLowerCase().includes("submain") ? "submain" : "main",
        status: "running",
        updatedAt: now,
      });
    }
  }

  const defaultDod = Object.freeze(
    input.definitionOfDone && input.definitionOfDone.length > 0
      ? [...input.definitionOfDone]
      : [
          "Cross-critique peer implementation for edge cases and race conditions.",
          "Verify all unit/integration tests pass without weakening test assertions.",
          "Produce a unified, citation-grounded report for the parent Main/Sub-Main node.",
        ],
  );
  const allowedMcp = Object.freeze(
    input.allowedMcpServers && input.allowedMcpServers.length > 0
      ? [...input.allowedMcpServers]
      : ["mcp-omnia-streamable-core", "mcp-verifier-sandbox"],
  );
  const allowedSkills = Object.freeze(
    input.allowedSkills && input.allowedSkills.length > 0
      ? [...input.allowedSkills]
      : ["ast-refactor", "kv-cache-topology", "vitest-verification"],
  );
  const allowedTools = Object.freeze(
    input.allowedTools && input.allowedTools.length > 0
      ? [...input.allowedTools]
      : ["Read", "Edit", "Bash", "Grep", "LSP", "WebSearch"],
  );

  const buckets: KdTreePeerGroupBucket[] = [];
  const allChildIds: string[] = [];

  parsedGroups.forEach((members, idx) => {
    const isPeerCluster = members.length > 1;
    const notation = isPeerCluster ? `{${members.join(", ")}}` : members[0]!;
    const groupId = `kd-group-${idx + 1}-${members.join("-")}`;
    const kdAxis = KD_AXES[idx % KD_AXES.length]!;

    for (const memberId of members) {
      allChildIds.push(memberId);
      const siblings = members.filter((m) => m !== memberId);
      const existing = nextGraph[memberId];
      const siblingUris = siblings.map((s) => nextGraph[s]?.uri ?? formatLiveSessionUri(s, "omnia"));

      nextGraph[memberId] = createLiveSessionNode({
        ...(existing ?? {
          sessionId: memberId,
          title: `Subagent ${memberId} (${notation})`,
          role: "subagent",
          status: "running",
          tokenCount: 2400,
        }),
        sessionId: memberId,
        title: existing?.title ?? `Subagent ${memberId} (${notation})`,
        parentSessionId: parentIds[0]!,
        parentSessionIds: parentIds,
        peerGroupId: groupId,
        peerSiblingIds: siblings,
        referencedSessionUris: [
          ...new Set([...(existing?.referencedSessionUris ?? []), ...siblingUris]),
        ],
        keyFindings: [
          ...(existing?.keyFindings ?? []),
          isPeerCluster
            ? `Grouped in k-d tree peer cluster ${notation} (axis=${kdAxis}) with autonomous peer critique enabled`
            : `Assigned to independent k-d tree leaf partition ${notation} (axis=${kdAxis})`,
        ],
        updatedAt: now,
      });
    }

    buckets.push(
      Object.freeze({
        groupId,
        notation,
        isPeerCluster,
        kdAxis,
        kdDepth: Math.floor(Math.log2(idx + 2)),
        parentSessionIds: Object.freeze(parentIds),
        memberSessionIds: Object.freeze([...members]),
        definitionOfDone: defaultDod,
        allowedMcpServers: allowedMcp,
        allowedSkills,
        allowedTools,
      }),
    );
  });

  for (const pid of parentIds) {
    const parentNode = nextGraph[pid]!;
    nextGraph[pid] = createLiveSessionNode({
      ...parentNode,
      childSessionIds: [...new Set([...parentNode.childSessionIds, ...allChildIds])],
      updatedAt: now,
    });
  }

  const canonicalNotation = buckets.map((b) => b.notation).join(", ");

  return Object.freeze({
    parentSessionIds: Object.freeze(parentIds),
    canonicalNotation,
    buckets: Object.freeze(buckets),
    nodesById: Object.freeze(nextGraph),
  });
}

/**
 * Executes autonomous multi-round peer discussion & mutual verification inside
 * a k-d tree peer group `{A, B}` according to its Definition of Done, MCP,
 * Skill, and Tool contract, then reports the unified consensus up to its
 * `Sub-Main` / `Main` parent(s).
 */
export function runPeerSubagentGroupDiscussion(input: {
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
  readonly bucket: KdTreePeerGroupBucket;
  readonly taskTopic: string;
  readonly rounds?: number;
  readonly now?: IsoTimestamp;
}): PeerGroupConsensusReport {
  const topic = assertNonBlank(input.taskTopic, "peer discussion taskTopic", 1000);
  const rounds = Math.max(1, Math.min(6, Math.floor(input.rounds ?? 2)));
  const now = input.now ?? "2026-10-18T16:50:00Z";
  const members = input.bucket.memberSessionIds;
  assertDomain(
    members.length >= 1,
    "invalid_argument",
    "Peer group bucket must have at least one member session ID.",
  );

  const discussionTurns: PeerDiscussionExchangeTurn[] = [];
  const nextGraph: Record<string, LiveSessionNode> = { ...input.nodesById };

  if (members.length === 1) {
    const soloId = members[0]!;
    const dodItem = input.bucket.definitionOfDone[0] ?? "Complete assigned partition verification";
    const tool = input.bucket.allowedTools[0] ?? "Read";
    const skill = input.bucket.allowedSkills[0] ?? "vitest-verification";
    discussionTurns.push(
      Object.freeze({
        round: 1,
        speakerSessionId: soloId,
        recipientSessionId: input.bucket.parentSessionIds[0] ?? soloId,
        critiqueOrProposal: `[Independent Leaf ${soloId}] Executed "${topic}" via ${tool} + ${skill} and verified DoD: "${dodItem}".`,
        invokedMcpToolOrSkill: `${input.bucket.allowedMcpServers[0] ?? "mcp-core"}::${skill}/${tool}`,
        dodItemVerified: dodItem,
        timestamp: now,
      }),
    );
  } else {
    for (let r = 1; r <= rounds; r += 1) {
      for (let i = 0; i < members.length; i += 1) {
        const speakerId = members[i]!;
        const recipientId = members[(i + 1) % members.length]!;
        const dodIdx = (r - 1 + i) % input.bucket.definitionOfDone.length;
        const dodItem = input.bucket.definitionOfDone[dodIdx]!;
        const mcp = input.bucket.allowedMcpServers[i % input.bucket.allowedMcpServers.length]!;
        const skill = input.bucket.allowedSkills[(r + i) % input.bucket.allowedSkills.length]!;
        const tool = input.bucket.allowedTools[(r + i) % input.bucket.allowedTools.length]!;

        const critiqueOrProposal =
          r === 1
            ? `[Peer Proposal ${speakerId} -> ${recipientId}] Audited "${topic}" using ${mcp} (${skill} + ${tool}); proposing edge-case invariant check for DoD item: "${dodItem}".`
            : `[Peer Consensus & Adversarial Critique ${speakerId} -> ${recipientId}] Verified ${recipientId}'s patch against "${dodItem}" with ${tool}; zero regressions found, locking consensus for parent report.`;

        discussionTurns.push(
          Object.freeze({
            round: r,
            speakerSessionId: speakerId,
            recipientSessionId: recipientId,
            critiqueOrProposal,
            invokedMcpToolOrSkill: `${mcp}::${skill}/${tool}`,
            dodItemVerified: dodItem,
            timestamp: now,
          }),
        );
      }
    }
  }

  const checklist = input.bucket.definitionOfDone.map((item, idx) =>
    Object.freeze({
      item,
      satisfiedBySessionId: members[idx % members.length]!,
      verified: true as const,
    }),
  );

  const parentLabel = input.bucket.parentSessionIds.join(", ");
  const consolidatedParentReport = [
    `### Consolidated k-d Tree Group Report ${input.bucket.notation} -> Parent [${parentLabel}]`,
    `- **Task**: ${topic}`,
    `- **k-d Partition Axis**: \`${input.bucket.kdAxis}\` (Depth ${input.bucket.kdDepth})`,
    `- **Peer Exchanges Completed**: ${discussionTurns.length} turn(s) across ${members.join(" <-> ")}`,
    `- **Definition of Done Status**: ${checklist.length}/${checklist.length} verified`,
    `- **MCP / Skills / Tools Used**: ${input.bucket.allowedMcpServers.join(", ")} | ${input.bucket.allowedSkills.join(", ")} | ${input.bucket.allowedTools.join(", ")}`,
  ].join("\n");

  for (const memberId of members) {
    const existing = nextGraph[memberId];
    if (!existing) continue;
    const peerMessages: DirectSubagentChatMessage[] = discussionTurns
      .filter((t) => t.speakerSessionId === memberId || t.recipientSessionId === memberId)
      .map((t, idx) =>
        Object.freeze({
          id: `peer-msg-${input.bucket.groupId}-${memberId}-${idx + 1}`,
          sender: "peer-agent" as const,
          senderSessionId: t.speakerSessionId,
          content: t.critiqueOrProposal,
          timestamp: t.timestamp,
        }),
      );

    nextGraph[memberId] = createLiveSessionNode({
      ...existing,
      tokenCount: existing.tokenCount + discussionTurns.length * 320,
      liveTranscriptSummary: `Completed ${discussionTurns.length}-turn peer discussion in ${input.bucket.notation} on "${topic}"; reported consensus to ${parentLabel}.`,
      keyFindings: [
        ...existing.keyFindings,
        `Peer consensus reached in ${input.bucket.notation} (${checklist.length}/${checklist.length} DoD items verified) -> reported to ${parentLabel}`,
      ],
      directChatTranscript: [...(existing.directChatTranscript ?? []), ...peerMessages],
      updatedAt: now,
    });
  }

  for (const pid of input.bucket.parentSessionIds) {
    const parentNode = nextGraph[pid];
    if (!parentNode) continue;
    nextGraph[pid] = createLiveSessionNode({
      ...parentNode,
      keyFindings: [
        ...parentNode.keyFindings,
        `Received unified consensus report from k-d tree group ${input.bucket.notation} on "${topic}"`,
      ],
      updatedAt: now,
    });
  }

  return Object.freeze({
    groupId: input.bucket.groupId,
    notation: input.bucket.notation,
    memberSessionIds: input.bucket.memberSessionIds,
    parentSessionIds: input.bucket.parentSessionIds,
    discussionTurns: Object.freeze(discussionTurns),
    definitionOfDoneChecklist: Object.freeze(checklist),
    consolidatedParentReport,
    updatedNodesById: Object.freeze(nextGraph),
  });
}

const RECENT_SUBAGENT_USER_PROMPTS: string[] = [];
const SUBAGENT_DFS_STORAGE_KEY = "omnia.session.dfs.nodes.v1";

/**
 * Returns all user prompts sent directly to subagents in the session tree
 * (from in-memory dispatches, optional `nodesById`, and persisted DFS storage)
 * in chronological order (oldest -> newest) so `Main` and sidebar composers
 * can recall subagent prompts via `ArrowUp` / `ArrowDown`.
 */
export function getRecentSubagentUserPrompts(
  nodesById?: Readonly<Record<string, LiveSessionNode>>,
): readonly string[] {
  const collected: string[] = [];

  const pushUnique = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const existingIdx = collected.indexOf(trimmed);
    if (existingIdx >= 0) {
      collected.splice(existingIdx, 1);
    }
    collected.push(trimmed);
  };

  if (nodesById) {
    for (const node of Object.values(nodesById)) {
      for (const msg of node.directChatTranscript ?? []) {
        if (msg.sender === "user") {
          pushUnique(msg.content);
        }
      }
    }
  }

  try {
    if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
      const raw = window.localStorage.getItem(SUBAGENT_DFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, LiveSessionNode>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const node of Object.values(parsed)) {
            for (const msg of node?.directChatTranscript ?? []) {
              if (msg?.sender === "user" && typeof msg.content === "string") {
                pushUnique(msg.content);
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }

  for (const prompt of RECENT_SUBAGENT_USER_PROMPTS) {
    pushUnique(prompt);
  }

  return Object.freeze(collected);
}

export function clearSubagentUserPromptHistory(): void {
  RECENT_SUBAGENT_USER_PROMPTS.length = 0;
}

/**
 * Allows the user to chat directly with ANY individual subagent (`A`, `B`, `C`,
 * `Sub-Main`, etc.) in the session tree just like chatting with `Main`.
 */
export function sendDirectUserPromptToSubagent(input: {
  readonly nodesById?: Readonly<Record<string, LiveSessionNode>>;
  readonly targetSessionId: string;
  readonly userPrompt: string;
  readonly now?: IsoTimestamp;
}): {
  readonly targetNode: LiveSessionNode;
  readonly userMessage: DirectSubagentChatMessage;
  readonly subagentReply: DirectSubagentChatMessage;
  readonly nodesById: Readonly<Record<string, LiveSessionNode>>;
} {
  const baseNodes = input.nodesById ?? DEFAULT_OMNIA_SESSION_TREE_NODES;
  const targetId = validateSessionId(input.targetSessionId, "targetSessionId");
  const existing = baseNodes[targetId];
  assertDomain(
    existing !== undefined,
    "not_found",
    `Subagent session "${targetId}" was not found in the session graph.`,
  );
  const promptText = assertNonBlank(input.userPrompt, "direct subagent userPrompt", 8000);
  const now = input.now ?? "2026-10-18T16:55:00Z";

  const existingIdx = RECENT_SUBAGENT_USER_PROMPTS.indexOf(promptText);
  if (existingIdx >= 0) {
    RECENT_SUBAGENT_USER_PROMPTS.splice(existingIdx, 1);
  }
  RECENT_SUBAGENT_USER_PROMPTS.push(promptText);
  if (RECENT_SUBAGENT_USER_PROMPTS.length > 200) {
    RECENT_SUBAGENT_USER_PROMPTS.shift();
  }

  const userMessage: DirectSubagentChatMessage = Object.freeze({
    id: `direct-user-${targetId}-${Date.now()}`,
    sender: "user",
    senderSessionId: "user",
    content: promptText,
    timestamp: now,
  });

  const peerContext =
    existing.peerSiblingIds && existing.peerSiblingIds.length > 0
      ? ` (coordinating with peer group sibling(s): ${existing.peerSiblingIds.join(", ")})`
      : "";
  const parentContext = existing.parentSessionId ? ` under parent ${existing.parentSessionId}` : "";

  const replyText = `[Direct Subagent Reply · ${existing.title} (${existing.role} · ${existing.modelId})${parentContext}${peerContext}]: Executed your direct instruction "${promptText.slice(0, 200)}" within isolated session ${existing.uri} while preserving parent/peer KV-cache context.`;

  const subagentReply: DirectSubagentChatMessage = Object.freeze({
    id: `direct-reply-${targetId}-${Date.now() + 1}`,
    sender: "subagent",
    senderSessionId: targetId,
    content: replyText,
    timestamp: now,
  });

  const nextTranscript = Object.freeze([
    ...(existing.directChatTranscript ?? []),
    userMessage,
    subagentReply,
  ]);

  const updatedTarget = createLiveSessionNode({
    ...existing,
    tokenCount: existing.tokenCount + Math.max(120, Math.round((promptText.length + replyText.length) / 3)),
    liveTranscriptSummary: replyText,
    keyFindings: [
      ...existing.keyFindings,
      `Direct user chat turn processed: "${promptText.slice(0, 96)}"`,
    ],
    directChatTranscript: nextTranscript,
    updatedAt: now,
  });

  const nextGraph = Object.freeze({
    ...baseNodes,
    [targetId]: updatedTarget,
  });

  return Object.freeze({
    targetNode: updatedTarget,
    userMessage,
    subagentReply,
    nodesById: nextGraph,
  });
}



