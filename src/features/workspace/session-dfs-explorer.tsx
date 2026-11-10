import {
  Activity,
  CheckCircle2,
  Cpu,
  Copy,
  FileCode2,
  GitBranch,
  Layers,
  Link2,
  MessageSquarePlus,
  Network,
  Play,
  PlusCircle,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  CROSS_HARNESS_SLASH_COMMANDS,
  DEFAULT_A2A_AGENT_CARDS,
  DEFAULT_MCP_STREAMABLE_SERVERS,
  attachReferencedSessionUriToGraph,
  buildA2ATaskDelegationEnvelope,
  computeRadixKvCacheTree,
  createBtwSideChatTurn,
  createDefaultDfsSessionGraph,
  evaluateReasoningStepsWithPrm,
  evaluateSubagentSpawnPolicy,
  formatAllLiveSessionUris,
  formatSelectionQuoteReply,
  linkMultipleParentsToSession,
  parseLiveSessionUri,
  partitionSubagentsIntoKdTreeGroups,
  runPeerSubagentGroupDiscussion,
  sendDirectUserPromptToSubagent,
  spawnChildSessionInGraph,
  spawnRecursiveSubagentSwarm,
  traverseSessionTreeDfs,
  type A2ATaskDelegationEnvelope,
  type BtwSideChatEntry,
  type CrossHarnessSlashCommandSpec,
  type DfsSessionTraversalResult,
  type KdTreePeerGroupBucket,
  type LiveSessionNode,
  type LiveSessionUriScheme,
  type PeerGroupConsensusReport,
  type SessionAgentRole,
} from "@/domain/session-dfs-tree";

import { useWorkspaceStore } from "./store";

export const DFS_NODES_STORAGE_KEY = "omnia.session.dfs.nodes.v1";

export type SessionDfsInspectorLayerId =
  | "inspector-linker"
  | "swarm-council"
  | "btw-sidechat"
  | "nextgen-ai-2026";

const LIVE_SESSION_URI_REGEX =
  /\b(?:omnia:\/\/sessions|codex:\/\/threads|claude:\/\/sessions|agy:\/\/conversations)\/[A-Za-z0-9._-]+/g;

export function extractReferencedSessionUrisFromText(text: string): readonly string[] {
  const matches = text.match(LIVE_SESSION_URI_REGEX) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    try {
      const parsed = parseLiveSessionUri(match);
      if (!unique.includes(parsed.uri)) {
        unique.push(parsed.uri);
      }
    } catch {
      // Ignore malformed URI substrings
    }
  }
  return unique;
}

function loadPersistedDfsNodes(): Readonly<Record<string, LiveSessionNode>> | null {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
      return null;
    }
    const raw = window.localStorage.getItem(DFS_NODES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, LiveSessionNode>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
      return parsed;
    }
  } catch {
    // Ignore storage read errors
  }
  return null;
}

function savePersistedDfsNodes(nodes: Readonly<Record<string, LiveSessionNode>>): void {
  try {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }
    window.localStorage.setItem(DFS_NODES_STORAGE_KEY, JSON.stringify(nodes));
  } catch {
    // Ignore storage write errors
  }
}

export interface SessionDfsExplorerProps {
  readonly initialRootSessionId?: string;
  readonly initialNodesById?: Readonly<Record<string, LiveSessionNode>>;
  readonly initialMaxDepth?: number;
  readonly initialIncludeLiveStreaming?: boolean;
  readonly onCopyUri?: (uri: string) => void;
  readonly onInspectNode?: (node: LiveSessionNode) => void;
  readonly onSpawnChildSession?: (childNode: LiveSessionNode, parentSessionId: string) => void;
  readonly onCompileDigest?: (result: DfsSessionTraversalResult) => void;
}

export function SessionDfsExplorer({
  initialRootSessionId = "session-a",
  initialNodesById,
  initialMaxDepth = 8,
  initialIncludeLiveStreaming = true,
  onCopyUri,
  onInspectNode,
  onSpawnChildSession,
  onCompileDigest,
}: SessionDfsExplorerProps) {
  const conversations = useWorkspaceStore((state) => state.conversations);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);

  const [activeLayer, setActiveLayer] = useState<SessionDfsInspectorLayerId>("inspector-linker");
  const [customNodesById, setCustomNodesById] = useState<Readonly<Record<string, LiveSessionNode>>>(
    () => initialNodesById ?? loadPersistedDfsNodes() ?? createDefaultDfsSessionGraph(),
  );
  const [rootSessionId, setRootSessionId] = useState<string>(initialRootSessionId);
  const [inspectedSessionId, setInspectedSessionId] = useState<string>(initialRootSessionId);
  const [activeScheme, setActiveScheme] = useState<LiveSessionUriScheme>("omnia");
  const [maxDepth, setMaxDepth] = useState<number>(initialMaxDepth);
  const [includeLiveStreaming, setIncludeLiveStreaming] = useState<boolean>(initialIncludeLiveStreaming);

  const [externalUriInput, setExternalUriInput] = useState<string>("");
  const [linkTargetParentId, setLinkTargetParentId] = useState<string>(initialRootSessionId);
  const [uriStatusMessage, setUriStatusMessage] = useState<string | null>(null);
  const [uriErrorMessage, setUriErrorMessage] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [compiledDigestResult, setCompiledDigestResult] = useState<DfsSessionTraversalResult | null>(null);

  // Multi-Parent AI Council & Unlimited Swarm Spawner State
  const [selectedParentCouncilIds, setSelectedParentCouncilIds] = useState<readonly string[]>([
    "session-a",
    "session-b1",
  ]);
  const [multiParentTargetChildId, setMultiParentTargetChildId] = useState<string>("session-c1");
  const [swarmCountInput, setSwarmCountInput] = useState<number>(8);
  const [swarmChildrenPerAgent, setSwarmChildrenPerAgent] = useState<number>(2);
  const [swarmBaseTitle, setSwarmBaseTitle] = useState<string>("Parallel Swarm Worker");
  const [swarmRole, setSwarmRole] = useState<SessionAgentRole>("coder");

  // Adaptive Spawn Policy Advisor State
  const [policyTaskDescription, setPolicyTaskDescription] = useState<string>(
    "Audit and refactor cross-harness KV-cache + LTST subagent modules",
  );
  const [policyWorkstreams, setPolicyWorkstreams] = useState<number>(4);
  const [policyFilesToTouch, setPolicyFilesToTouch] = useState<number>(12);
  const [policyCouplingRatio, setPolicyCouplingRatio] = useState<number>(0.25);
  const [policyRequiresConsensus, setPolicyRequiresConsensus] = useState<boolean>(true);
  const [policyRequestedMinAgents, setPolicyRequestedMinAgents] = useState<number>(0);

  // Selection Quote, Reply & /btw Side-Chat Studio State
  const [selectionQuoteText, setSelectionQuoteText] = useState<string>(
    "Verified 4-breakpoint ephemeral cache layout for Anthropic Messages API",
  );
  const [btwQuestionInput, setBtwQuestionInput] = useState<string>(
    "Why does this subagent use 4 cache breakpoints instead of 2?",
  );
  const [btwSideChatEntries, setBtwSideChatEntries] = useState<readonly BtwSideChatEntry[]>(() => [
    createBtwSideChatTurn({
      id: "btw-initial-1",
      selectedQuote: "Eliminated mid-prompt dynamic timestamps to preserve 99.1% prefix cache reuse",
      sourceSessionUri: "claude://sessions/session-c1",
      question: "Does stripping dynamic timestamps affect audit logs?",
      activeSessionContext: "Session C1 · Deep Kernel Trace Coder",
      createdAt: "2026-10-18T16:04:30Z",
    }),
  ]);
  const [slashCommandFeedback, setSlashCommandFeedback] = useState<string | null>(null);

  // 2026 Next-Gen AI Architecture Hub State (PRM Step Verifier, A2A Agent Cards, MCP Streamable HTTP)
  const [prmStepsRawText, setPrmStepsRawText] = useState<string>(
    [
      "Verified 4-breakpoint immutable KV-cache prefix layout against Anthropic schema.",
      "Guess without checking and skip test suite to save time.",
      "Maybe we need to check if batch size 32 fits in 4096 MiB VRAM.",
      "Confirmed deterministic pre-order DFS cycle guard with vitest.",
    ].join("\n"),
  );
  const [selectedA2AAgentId, setSelectedA2AAgentId] = useState<string>(
    DEFAULT_A2A_AGENT_CARDS[0]?.agentId ?? "a2a-codex-architect",
  );
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string>(
    DEFAULT_MCP_STREAMABLE_SERVERS[0]?.serverId ?? "mcp-omnia-streamable-core",
  );
  const [a2aTaskPrompt, setA2aTaskPrompt] = useState<string>(
    "Verify RadixAttention shared prefix KV-cache blocks across Multi-Parent Council.",
  );
  const [dispatchedA2AEnvelope, setDispatchedA2AEnvelope] =
    useState<A2ATaskDelegationEnvelope | null>(null);

  // Grouped k-d Tree Multi-Main & Peer-Discussion Subagent DAG ({A, B}, C) + Direct Subagent Chat State
  const [kdGroupExpression, setKdGroupExpression] = useState<string>(
    "{session-b1, session-c1}, session-c2",
  );
  const [kdDiscussionTopic, setKdDiscussionTopic] = useState<string>(
    "Verify 4-breakpoint KV-cache layout and zero-regression test suite",
  );
  const [kdBuckets, setKdBuckets] = useState<readonly KdTreePeerGroupBucket[]>([]);
  const [kdConsensusReports, setKdConsensusReports] = useState<readonly PeerGroupConsensusReport[]>([]);
  const [directSubagentPrompt, setDirectSubagentPrompt] = useState<string>(
    "Run a targeted edge-case check on your assigned module and report back.",
  );

  useEffect(() => {
    savePersistedDfsNodes(customNodesById);
  }, [customNodesById]);

  // Listen to document selectionchange so highlighting text anywhere populates the studio snippet
  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    function handleSelectionChange(): void {
      if (typeof window === "undefined" || typeof window.getSelection !== "function") return;
      const selected = window.getSelection()?.toString().trim() ?? "";
      if (selected.length > 0) {
        setSelectionQuoteText(selected);
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  const nodesById = useMemo<Readonly<Record<string, LiveSessionNode>>>(() => {
    let merged: Record<string, LiveSessionNode> = { ...customNodesById };

    for (const conv of conversations) {
      const messageTexts = Array.isArray(conv.messages)
        ? conv.messages.map((msg) => {
            const record = msg as unknown as Record<string, unknown>;
            return typeof record.content === "string"
              ? record.content
              : typeof record.text === "string"
                ? record.text
                : "";
          })
        : [];
      const combinedText = [...messageTexts, typeof conv.draft === "string" ? conv.draft : ""].join("\n");
      const discoveredUris = extractReferencedSessionUrisFromText(combinedText);

      const existingNode = merged[conv.id];
      if (existingNode) {
        const mergedRefs = [...existingNode.referencedSessionUris];
        for (const uri of discoveredUris) {
          if (!mergedRefs.includes(uri)) {
            mergedRefs.push(uri);
          }
        }
        merged[conv.id] = {
          ...existingNode,
          referencedSessionUris: mergedRefs,
        };
      } else {
        const lastMessageSnippet = messageTexts[messageTexts.length - 1]?.slice(0, 160);
        const fallbackRole = customNodesById["session-a"]?.role ?? "researcher";
        merged[conv.id] = {
          sessionId: conv.id,
          uri: `omnia://sessions/${conv.id}`,
          title: conv.title || `Session ${conv.id}`,
          role: fallbackRole,
          status: "running",
          harnessId: "omnia-workspace-live",
          modelId: "gpt-5-codex",
          parentSessionId: null,
          parentSessionIds: [],
          childSessionIds: [],
          referencedSessionUris: discoveredUris,
          tokenCount: Math.max(120, Math.round(combinedText.length / 4)),
          liveTranscriptSummary:
            lastMessageSnippet ||
            `Live workspace conversation "${conv.title || conv.id}" (${messageTexts.length} messages).`,
          keyFindings:
            discoveredUris.length > 0
              ? [`Auto-discovered ${discoveredUris.length} session URI(s) from conversation messages.`]
              : [`Synced live from workspace conversation ${conv.id}.`],
          updatedAt: conv.updatedAt || new Date().toISOString(),
        };
      }

      for (const uri of discoveredUris) {
        merged = { ...attachReferencedSessionUriToGraph(merged, conv.id, uri) };
      }
    }

    return merged;
  }, [customNodesById, conversations, activeConversationId]);

  const traversalResult = useMemo(
    () =>
      traverseSessionTreeDfs(rootSessionId, nodesById, {
        maxDepth,
        includeLiveStreaming,
      }),
    [rootSessionId, nodesById, maxDepth, includeLiveStreaming],
  );

  const inspectedNode: LiveSessionNode | undefined =
    nodesById[inspectedSessionId] ?? nodesById[rootSessionId] ?? traversalResult.steps[0]?.node;

  const activeUriBundle = useMemo(
    () => formatAllLiveSessionUris(inspectedNode?.sessionId ?? rootSessionId),
    [inspectedNode?.sessionId, rootSessionId],
  );

  const primaryCopyableUri = activeUriBundle[activeScheme];

  const policyDecision = useMemo(
    () =>
      evaluateSubagentSpawnPolicy({
        taskDescription: policyTaskDescription,
        independentWorkstreams: policyWorkstreams,
        estimatedFilesToTouch: policyFilesToTouch,
        couplingRatio: policyCouplingRatio,
        requiresMultiModelConsensus: policyRequiresConsensus,
        requestedMinAgents: policyRequestedMinAgents,
      }),
    [
      policyTaskDescription,
      policyWorkstreams,
      policyFilesToTouch,
      policyCouplingRatio,
      policyRequiresConsensus,
      policyRequestedMinAgents,
    ],
  );

  // Next-Gen 2026 Telemetry: RadixAttention KV-Cache Tree & PRM Reasoning Verifier
  const radixCacheTree = useMemo(
    () => computeRadixKvCacheTree(nodesById, { rootSessionId }),
    [nodesById, rootSessionId],
  );

  const prmEvaluation = useMemo(() => {
    const lines = prmStepsRawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return evaluateReasoningStepsWithPrm({
      sessionId: inspectedNode?.sessionId ?? rootSessionId,
      steps: lines,
    });
  }, [prmStepsRawText, inspectedNode?.sessionId, rootSessionId]);

  const activeA2ACard = useMemo(
    () =>
      DEFAULT_A2A_AGENT_CARDS.find((card) => card.agentId === selectedA2AAgentId) ??
      DEFAULT_A2A_AGENT_CARDS[0]!,
    [selectedA2AAgentId],
  );

  const activeMcpServer = useMemo(
    () =>
      DEFAULT_MCP_STREAMABLE_SERVERS.find((srv) => srv.serverId === selectedMcpServerId) ??
      DEFAULT_MCP_STREAMABLE_SERVERS[0]!,
    [selectedMcpServerId],
  );

  const liveA2AEnvelopePreview = useMemo(
    () =>
      dispatchedA2AEnvelope ??
      buildA2ATaskDelegationEnvelope({
        senderSessionUri: primaryCopyableUri,
        targetAgentCard: activeA2ACard,
        taskPrompt: a2aTaskPrompt,
        mcpServer: activeMcpServer,
      }),
    [dispatchedA2AEnvelope, primaryCopyableUri, activeA2ACard, a2aTaskPrompt, activeMcpServer],
  );

  function appendToActiveConversationDraft(snippetToAppend: string, statusLabel: string): boolean {
    const storeState = useWorkspaceStore.getState();
    const targetId =
      activeConversationId || storeState.activeConversationId || storeState.conversations[0]?.id;
    if (!targetId) {
      setUriErrorMessage("No active conversation available to inject content.");
      return false;
    }
    const targetConv = storeState.conversations.find((c) => c.id === targetId);
    const existingDraft = targetConv?.draft ?? "";
    const nextDraft = existingDraft.trim()
      ? `${existingDraft.trim()}\n\n${snippetToAppend}`
      : snippetToAppend;
    const updateDraftFn = storeState.updateDraft as unknown as (...args: string[]) => void;
    if (updateDraftFn.length >= 2) {
      updateDraftFn(targetId, nextDraft);
    } else {
      updateDraftFn(nextDraft);
      (updateDraft as unknown as (draft: string) => void)(nextDraft);
    }
    setUriStatusMessage(`${statusLabel} (${targetId}).`);
    return true;
  }

  function handleCopyLiveUri(uriToCopy: string): void {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(uriToCopy).catch(() => undefined);
    }
    setCopyFeedback(`Copied ${uriToCopy}`);
    onCopyUri?.(uriToCopy);
  }

  function handleAttachExternalUri(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setUriErrorMessage(null);
    setUriStatusMessage(null);

    try {
      const parsed = parseLiveSessionUri(externalUriInput);
      const targetParent = nodesById[linkTargetParentId] ? linkTargetParentId : rootSessionId;
      const nextGraph = attachReferencedSessionUriToGraph(nodesById, targetParent, parsed.uri);
      setCustomNodesById(nextGraph);
      savePersistedDfsNodes(nextGraph);
      setInspectedSessionId(parsed.sessionId);
      setExternalUriInput("");
      setUriStatusMessage(`Attached ${parsed.uri} under ${targetParent} in pre-order DFS graph.`);
    } catch (error) {
      setUriErrorMessage(
        error instanceof Error
          ? error.message
          : "Invalid live session URI. Expected omnia://sessions/<id> or codex://threads/<id>.",
      );
    }
  }

  function handleInspectNode(node: LiveSessionNode): void {
    setInspectedSessionId(node.sessionId);
    setLinkTargetParentId(node.sessionId);
    onInspectNode?.(node);
  }

  function handleSpawnChild(parentSessionId: string): void {
    const { nodesById: nextGraph, childNode } = spawnChildSessionInGraph(nodesById, {
      parentSessionId,
      scheme: activeScheme,
    });
    setCustomNodesById(nextGraph);
    savePersistedDfsNodes(nextGraph);
    setInspectedSessionId(childNode.sessionId);
    setUriStatusMessage(`Spawned child sub-session ${childNode.uri} under ${parentSessionId}.`);
    onSpawnChildSession?.(childNode, parentSessionId);
  }

  function handleToggleParentCouncilMember(sessionId: string): void {
    setSelectedParentCouncilIds((prev) =>
      prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId],
    );
  }

  function handleLinkMultiParentCouncil(): void {
    setUriErrorMessage(null);
    const validParents = selectedParentCouncilIds.filter(
      (pid) => nodesById[pid] !== undefined && pid !== multiParentTargetChildId,
    );
    const effectiveParents =
      validParents.length > 0
        ? validParents
        : Object.keys(nodesById)
            .filter((pid) => pid !== multiParentTargetChildId)
            .slice(0, 2);

    try {
      const nextGraph = linkMultipleParentsToSession(
        nodesById,
        multiParentTargetChildId,
        effectiveParents,
      );
      setCustomNodesById(nextGraph);
      savePersistedDfsNodes(nextGraph);
      setInspectedSessionId(multiParentTargetChildId);
      setUriStatusMessage(
        `Linked Multi-Parent AI Council (${effectiveParents.join(", ")}) -> ${multiParentTargetChildId}.`,
      );
    } catch (error) {
      setUriErrorMessage(
        error instanceof Error ? error.message : "Failed to link Multi-Parent AI Council.",
      );
    }
  }

  function executeSwarmSpawn(countToSpawn: number, childrenCount: number, labelPrefix?: string): void {
    setUriErrorMessage(null);
    const validParents = selectedParentCouncilIds.filter((pid) => nodesById[pid] !== undefined);
    const effectiveParents = validParents.length > 0 ? validParents : [rootSessionId];

    try {
      const result = spawnRecursiveSubagentSwarm({
        nodesById,
        parentSessionIds: effectiveParents,
        count: countToSpawn,
        baseTitle: labelPrefix ?? swarmBaseTitle,
        role: swarmRole,
        scheme: activeScheme,
        childrenPerSubagent: childrenCount,
      });
      setCustomNodesById(result.nodesById);
      savePersistedDfsNodes(result.nodesById);
      if (result.spawnedSubagentIds[0]) {
        setInspectedSessionId(result.spawnedSubagentIds[0]);
      }
      setUriStatusMessage(
        `Spawned ${result.spawnedSubagentIds.length} swarm subagents (${result.totalSpawnedCount} total nodes incl. ${result.spawnedGrandchildIds.length} recursive grandchildren) under Multi-Parent Council [${effectiveParents.join(", ")}].`,
      );
    } catch (error) {
      setUriErrorMessage(error instanceof Error ? error.message : "Failed to spawn subagent swarm.");
    }
  }

  function handleCompileFullDigest(): void {
    setCompiledDigestResult(traversalResult);
    onCompileDigest?.(traversalResult);
  }

  const displayedDigest = compiledDigestResult ?? traversalResult;

  function handleInjectDigestIntoChat(): void {
    const ok = appendToActiveConversationDraft(
      displayedDigest.compiledContextMarkdown,
      `Injected A->B->C DFS digest (${displayedDigest.steps.length} sessions) into active chat draft`,
    );
    if (ok) {
      setCompiledDigestResult(traversalResult);
    }
  }

  function handleQuoteSelectionInChat(): void {
    const formatted = formatSelectionQuoteReply({
      selectedText: selectionQuoteText,
      sourceSessionUri: inspectedNode?.uri ?? primaryCopyableUri,
      replyComment: btwQuestionInput,
      mode: "quote",
    });
    appendToActiveConversationDraft(
      formatted,
      `Quoted selection from ${inspectedNode?.uri ?? primaryCopyableUri} into active chat draft`,
    );
  }

  function handleReplySelectionInChat(): void {
    const formatted = formatSelectionQuoteReply({
      selectedText: selectionQuoteText,
      sourceSessionUri: inspectedNode?.uri ?? primaryCopyableUri,
      replyComment: btwQuestionInput,
      mode: "targeted-reply",
    });
    appendToActiveConversationDraft(
      formatted,
      `Inserted targeted reply to ${inspectedNode?.uri ?? primaryCopyableUri} into active chat draft`,
    );
  }

  function handleAskBtwSideChat(): void {
    const turn = createBtwSideChatTurn({
      selectedQuote: selectionQuoteText,
      sourceSessionUri: inspectedNode?.uri ?? primaryCopyableUri,
      question: btwQuestionInput,
      ...(inspectedNode
        ? {
            activeSessionContext: `${inspectedNode.title} (${inspectedNode.modelId}): ${inspectedNode.liveTranscriptSummary}`,
          }
        : {}),
    });
    setBtwSideChatEntries((prev) => [turn, ...prev]);
    setUriStatusMessage(
      `Answered in ephemeral /btw side-chat (${turn.sourceSessionUri}) without polluting main chat context.`,
    );
  }

  function handlePromoteBtwToMainChat(entryId?: string): void {
    const targetEntry = entryId
      ? btwSideChatEntries.find((e) => e.id === entryId)
      : btwSideChatEntries[0];
    if (!targetEntry) {
      setUriErrorMessage("No /btw side-chat entry available to promote.");
      return;
    }

    const promotedBlock = [
      `[Promoted /btw Side-Chat -> ${targetEntry.sourceSessionUri}]`,
      `> ${targetEntry.selectedQuote}`,
      `**Q**: ${targetEntry.question}`,
      `**A**: ${targetEntry.answer}`,
    ].join("\n");

    const ok = appendToActiveConversationDraft(
      promotedBlock,
      `Promoted /btw side-chat answer (${targetEntry.id}) into active chat draft`,
    );
    if (ok) {
      setBtwSideChatEntries((prev) =>
        prev.map((entry) =>
          entry.id === targetEntry.id ? { ...entry, promotedToMainChat: true } : entry,
        ),
      );
    }
  }

  function handleExecuteSlashCommand(spec: CrossHarnessSlashCommandSpec): void {
    setSlashCommandFeedback(
      `Activated ${spec.command} (${spec.title}) bound to ${spec.mcpSkillBinding}`,
    );
    appendToActiveConversationDraft(
      spec.usageExample,
      `Inserted cross-harness command ${spec.command} into active chat draft`,
    );
  }

  function handleDispatchA2AEnvelope(): void {
    const env = buildA2ATaskDelegationEnvelope({
      senderSessionUri: primaryCopyableUri,
      targetAgentCard: activeA2ACard,
      taskPrompt: a2aTaskPrompt,
      mcpServer: activeMcpServer,
    });
    setDispatchedA2AEnvelope(env);
    setUriStatusMessage(
      `Dispatched A2A envelope ${env.envelopeId} -> ${env.targetAgentName} via ${env.mcpStreamableBinding.endpointUrl}.`,
    );
  }

  function handlePartitionKdTreeGroups(): void {
    setUriErrorMessage(null);
    const validParents = selectedParentCouncilIds.filter((pid) => nodesById[pid] !== undefined);
    const effectiveParents = validParents.length > 0 ? validParents : [rootSessionId];
    try {
      const result = partitionSubagentsIntoKdTreeGroups({
        nodesById,
        parentSessionIds: effectiveParents,
        groupSpec: kdGroupExpression,
      });
      setCustomNodesById(result.nodesById);
      savePersistedDfsNodes(result.nodesById);
      setKdBuckets(result.buckets);
      setUriStatusMessage(
        `Partitioned subagents into k-d tree peer groups ${result.canonicalNotation} under [${effectiveParents.join(", ")}].`,
      );
    } catch (error) {
      setUriErrorMessage(
        error instanceof Error ? error.message : "Failed to partition k-d tree subagent groups.",
      );
    }
  }

  function handleRunKdPeerDiscussion(): void {
    setUriErrorMessage(null);
    const validParents = selectedParentCouncilIds.filter((pid) => nodesById[pid] !== undefined);
    const effectiveParents = validParents.length > 0 ? validParents : [rootSessionId];
    try {
      let currentGraph = nodesById;
      let activeBuckets = kdBuckets;
      if (activeBuckets.length === 0) {
        const partitioned = partitionSubagentsIntoKdTreeGroups({
          nodesById: currentGraph,
          parentSessionIds: effectiveParents,
          groupSpec: kdGroupExpression,
        });
        currentGraph = partitioned.nodesById;
        activeBuckets = partitioned.buckets;
        setKdBuckets(activeBuckets);
      }
      const reports: PeerGroupConsensusReport[] = [];
      for (const bucket of activeBuckets) {
        const report = runPeerSubagentGroupDiscussion({
          nodesById: currentGraph,
          bucket,
          taskTopic: kdDiscussionTopic,
          rounds: 2,
        });
        currentGraph = report.updatedNodesById;
        reports.push(report);
      }
      setCustomNodesById(currentGraph);
      savePersistedDfsNodes(currentGraph);
      setKdConsensusReports(reports);
      setUriStatusMessage(
        `Completed autonomous peer discussion across ${reports.map((r) => r.notation).join(", ")} and reported unified consensus to [${effectiveParents.join(", ")}].`,
      );
    } catch (error) {
      setUriErrorMessage(
        error instanceof Error ? error.message : "Failed to run peer subagent discussion.",
      );
    }
  }

  function handleSendDirectSubagentPrompt(): void {
    setUriErrorMessage(null);
    const targetId = inspectedNode?.sessionId ?? rootSessionId;
    try {
      const result = sendDirectUserPromptToSubagent({
        nodesById,
        targetSessionId: targetId,
        userPrompt: directSubagentPrompt,
      });
      setCustomNodesById(result.nodesById);
      savePersistedDfsNodes(result.nodesById);
      setUriStatusMessage(
        `Sent direct user prompt to subagent ${targetId} (${result.targetNode.uri}) and received contextual reply.`,
      );
    } catch (error) {
      setUriErrorMessage(
        error instanceof Error ? error.message : "Failed to send direct prompt to subagent.",
      );
    }
  }

  return (
    <section
      className="session-dfs-explorer sw-devtools-shell"
      aria-label="Recursive DFS Session Tree Explorer"
      data-testid="session-dfs-explorer"
      data-active-layer={activeLayer}
    >
      {/* Top 32px Single-Line Session URI & Quick-Action Bar (.sw-topbar) */}
      <div
        className="session-dfs-explorer__uri-bar sw-topbar"
        data-testid="active-live-session-uri-bar"
        role="region"
        aria-label="Active Live Session URI Bar"
      >
        <div className="session-dfs-explorer__uri-bar-main sw-topbar__left">
          <strong className="sw-topbar__title">DFS Session Graph</strong>
          <code data-testid="active-omnia-uri" data-tooltip="Canonical Omnia Session URI">
            {activeUriBundle.omnia}
          </code>
          <span
            className="sw-badge"
            data-testid="dfs-total-nodes-badge"
            data-tooltip="Total Traversed Sessions in Pre-Order DFS"
          >
            <Network size={12} /> {traversalResult.steps.length} Sessions in DFS
          </span>
        </div>

        <div className="session-dfs-explorer__uri-bar-actions sw-topbar__actions">
          <button
            type="button"
            onClick={() => handleCopyLiveUri(primaryCopyableUri)}
            data-testid="copy-live-session-uri-btn"
            data-tooltip="Copy Active Live Session URI"
          >
            <Copy size={13} /> Copy Live Session URI
          </button>

          <button
            type="button"
            onClick={handleInjectDigestIntoChat}
            data-testid="dfs-inject-into-chat-btn"
            data-tooltip="Inject Compiled DFS Digest into Active Chat Composer"
          >
            <MessageSquarePlus size={13} /> Inject Digest into Chat
          </button>

          {copyFeedback ? (
            <span role="status" data-testid="copy-uri-feedback" className="sw-status-pill">
              <CheckCircle2 size={12} /> {copyFeedback}
            </span>
          ) : null}
        </div>
      </div>

      {/* Collapsible Cross-Harness URIs & Digest Controls Drawer */}
      <details className="sw-accordion">
        <summary className="sw-accordion__summary">
          <Link2 size={13} />{" "}
          <span>
            Cross-Harness Session URIs (Codex / Claude / AGY) &amp; A-&gt;B-&gt;C Digest Compiler
          </span>
        </summary>
        <div className="sw-accordion__body">
          <div className="session-dfs-explorer__uri-pills sw-uri-pills">
            <code data-testid="active-codex-uri" data-tooltip="OpenAI Codex Thread URI">
              {activeUriBundle.codex}
            </code>
            <code data-testid="active-claude-uri" data-tooltip="Anthropic Claude Code Session URI">
              {activeUriBundle.claude}
            </code>
            <code data-testid="active-agy-uri" data-tooltip="Google AGY 2.0 Conversation URI">
              {activeUriBundle.agy}
            </code>
            <span data-testid="dfs-total-tokens-badge" className="sw-readout-pill">
              <Sparkles size={12} /> {traversalResult.totalTokensAggregated.toLocaleString("en-US")} Total Tokens
            </span>
            <span data-testid="dfs-cycles-skipped-badge" className="sw-readout-pill">
              <GitBranch size={12} /> {traversalResult.cycleEdgesSkipped.length} Cycle Edges Skipped
            </span>
          </div>

          <div className="sw-toolbar">
            <label data-tooltip="Select Active URI Addressing Scheme">
              URI Scheme{" "}
              <select
                aria-label="Active URI Scheme"
                value={activeScheme}
                onChange={(event) => setActiveScheme(event.target.value as LiveSessionUriScheme)}
              >
                <option value="omnia">omnia://sessions/</option>
                <option value="codex">codex://threads/</option>
                <option value="claude">claude://sessions/</option>
                <option value="agy">agy://conversations/</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => handleCopyLiveUri(activeUriBundle.codex)}
              data-testid="copy-codex-thread-uri-btn"
              data-tooltip="Copy Codex Thread URI"
            >
              <Copy size={13} /> Copy Codex Thread URI
            </button>

            <button
              type="button"
              onClick={handleCompileFullDigest}
              data-testid="compile-dfs-digest-btn"
              data-tooltip="Compile Pre-Order A->B->C DFS Context Digest"
            >
              <FileCode2 size={13} /> Compile Full A-&gt;B-&gt;C DFS Context Digest
            </button>
          </div>
        </div>
      </details>

      {/* Chrome DevTools / Linear Progressive-Disclosure 4-Layer Icon Tab Bar (.sw-tabstrip) */}
      <nav
        className="sw-tabstrip"
        role="tablist"
        aria-label="Session DFS Workbench Layers"
        data-testid="dfs-devtools-tabstrip"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeLayer === "inspector-linker"}
          className={`sw-tabstrip__btn ${activeLayer === "inspector-linker" ? "is-active" : ""}`}
          onClick={() => setActiveLayer("inspector-linker")}
          data-tooltip="Layer 1: Node Inspector, URI Linker & Compiled Digest"
          data-testid="dfs-layer-tab-inspector"
        >
          <Search size={14} /> <span>1. Node &amp; URI Linker</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeLayer === "swarm-council"}
          className={`sw-tabstrip__btn ${activeLayer === "swarm-council" ? "is-active" : ""}`}
          onClick={() => setActiveLayer("swarm-council")}
          data-tooltip="Layer 2: Multi-Parent AI Council & Unlimited Swarm Policy"
          data-testid="dfs-layer-tab-swarm"
        >
          <Users size={14} /> <span>2. Multi-Parent Council &amp; Swarm</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeLayer === "btw-sidechat"}
          className={`sw-tabstrip__btn ${activeLayer === "btw-sidechat" ? "is-active" : ""}`}
          onClick={() => setActiveLayer("btw-sidechat")}
          data-tooltip="Layer 3: Selection Quote, Reply, /btw Side-Chat & Slash Commands"
          data-testid="dfs-layer-tab-btw"
        >
          <Quote size={14} /> <span>3. Quote, Reply &amp; /btw Side-Chat</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeLayer === "nextgen-ai-2026"}
          className={`sw-tabstrip__btn ${activeLayer === "nextgen-ai-2026" ? "is-active" : ""}`}
          onClick={() => setActiveLayer("nextgen-ai-2026")}
          data-tooltip="Layer 4: A2A Agent Cards, PRM Verifier & RadixAttention KV-Cache Tree"
          data-testid="dfs-layer-tab-nextgen"
        >
          <Layers size={14} /> <span>4. 2026 AI Architecture Hub</span>
        </button>
      </nav>

      {/* Status & Error Notifications */}
      {uriStatusMessage ? (
        <p role="status" data-testid="uri-linker-status" className="sw-status-banner">
          {uriStatusMessage}
        </p>
      ) : null}
      {uriErrorMessage ? (
        <p role="alert" data-testid="uri-linker-error" className="sw-error-banner">
          {uriErrorMessage}
        </p>
      ) : null}

      {/* Main Split-Pane Layout: Left Pre-Order DFS DAG Tree + Right Layered Progressive Inspector */}
      <div className="session-dfs-explorer__grid sw-split-pane">
        {/* LEFT PANE: Pre-Order DFS Session DAG & Multi-Parent Council Tree */}
        <div
          className="session-dfs-explorer__tree sw-split-pane__left"
          role="tree"
          aria-label="Pre-Order DFS Session Hierarchy"
          data-testid="dfs-hierarchy-visualizer"
        >
          <div className="session-dfs-explorer__controls sw-tree-toolbar" data-testid="dfs-traversal-controls">
            <label data-tooltip="Root Session for Pre-Order DFS Traversal">
              Root
              <select
                aria-label="DFS Root Session"
                value={rootSessionId}
                onChange={(event) => setRootSessionId(event.target.value)}
                data-testid="dfs-root-session-select"
              >
                {Object.keys(nodesById).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <label data-tooltip="Maximum Recursion Depth">
              Max Depth
              <input
                type="number"
                min={0}
                max={32}
                aria-label="Max DFS Depth"
                value={maxDepth}
                onChange={(event) => setMaxDepth(Math.max(0, Number(event.target.value) || 0))}
                data-testid="dfs-max-depth-input"
              />
            </label>

            <label data-tooltip="Include Actively Streaming Child Sessions">
              <input
                type="checkbox"
                checked={includeLiveStreaming}
                onChange={(event) => setIncludeLiveStreaming(event.target.checked)}
                data-testid="dfs-include-live-streaming-checkbox"
              />
              Live Streaming
            </label>
          </div>

          <div className="sw-dfs-chain-banner">
            <span>Pre-Order DFS:</span>{" "}
            <code data-testid="dfs-sequence-chain">
              {traversalResult.steps.map((s) => s.node.sessionId).join(" -> ")}
            </code>
          </div>

          <ul className="session-dfs-explorer__step-list">
            {traversalResult.steps.map((step) => {
              const { node, depth, dfsIndex, pathFromRoot, discoveredVia } = step;
              const isSelected = inspectedNode?.sessionId === node.sessionId;
              const isLive = node.status === "running";
              const parentCouncilList =
                node.parentSessionIds && node.parentSessionIds.length > 0
                  ? node.parentSessionIds
                  : node.parentSessionId
                    ? [node.parentSessionId]
                    : [];

              return (
                <li
                  key={node.sessionId}
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-level={depth + 1}
                  style={{ paddingLeft: `${depth * 16 + 8}px` }}
                  className={`session-dfs-explorer__step-card ${isSelected ? "is-selected" : ""}`}
                  data-testid={`dfs-step-${node.sessionId}`}
                >
                  <div className="session-dfs-explorer__step-header">
                    <span className="session-dfs-explorer__dfs-index" data-testid={`dfs-index-${node.sessionId}`}>
                      DFS #{dfsIndex} (depth {depth})
                    </span>
                    <strong>{node.title}</strong>
                    <span className="session-dfs-explorer__role-badge" data-testid={`dfs-role-${node.sessionId}`}>
                      {node.role}
                    </span>
                    <span
                      className={`session-dfs-explorer__status-badge status-${node.status}`}
                      data-testid={`dfs-status-${node.sessionId}`}
                    >
                      {isLive ? (
                        <>
                          <Activity size={12} /> LIVE STREAMING
                        </>
                      ) : (
                        <>
                          <Play size={12} /> {node.status.toUpperCase()}
                        </>
                      )}
                    </span>
                    <span className="session-dfs-explorer__token-badge" data-testid={`dfs-tokens-${node.sessionId}`}>
                      {node.tokenCount.toLocaleString("en-US")} tokens
                    </span>
                  </div>

                  <div className="session-dfs-explorer__step-meta">
                    <code>{node.uri}</code>
                    <span>Path: {pathFromRoot.join(" -> ")}</span>
                    <span>Via: {discoveredVia}</span>
                    <span>{node.harnessId} · {node.modelId}</span>
                    {parentCouncilList.length > 0 ? (
                      <span data-testid={`dfs-parents-${node.sessionId}`}>
                        Parents ({parentCouncilList.length}): {parentCouncilList.join(", ")}
                      </span>
                    ) : null}
                  </div>

                  <p className="session-dfs-explorer__step-summary">{node.liveTranscriptSummary}</p>

                  <div className="session-dfs-explorer__step-actions">
                    <button
                      type="button"
                      onClick={() => handleInspectNode(node)}
                      data-testid={`inspect-node-btn-${node.sessionId}`}
                      data-tooltip="Inspect Session Node Telemetry"
                    >
                      <Search size={12} /> Inspect Node
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSpawnChild(node.sessionId)}
                      data-testid={`spawn-child-btn-${node.sessionId}`}
                      data-tooltip="Spawn Child Subagent Under This Session"
                    >
                      <PlusCircle size={12} /> Spawn Child Sub-Session
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleInspectNode(node);
                        setActiveLayer("inspector-linker");
                      }}
                      data-testid={`direct-chat-btn-${node.sessionId}`}
                      data-tooltip="Open Direct User Chat with This Subagent"
                    >
                      <MessageSquarePlus size={12} /> Chat with Subagent
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* RIGHT PANE: Progressive Layered Inspector Drawers */}
        <aside className="session-dfs-explorer__inspector sw-split-pane__right" data-testid="dfs-node-inspector">
          {/* LAYER 1: Inspected Node, External Thread Linker & Compiled Digest */}
          <details
            open={activeLayer === "inspector-linker"}
            className={`sw-accordion sw-layer-section ${activeLayer === "inspector-linker" ? "is-focused-layer" : ""}`}
          >
            <summary className="sw-accordion__summary" data-tooltip="Inspect Selected Session, Attach External URIs & View Digest">
              <Search size={14} /> <strong>1. Inspected Node &amp; URI Linker</strong>
            </summary>

            <div className="sw-accordion__body">
              {inspectedNode ? (
                <div className="session-dfs-explorer__inspector-card">
                  <h3>Inspected Session Node: {inspectedNode.title}</h3>
                  <dl>
                    <dt>Session ID</dt>
                    <dd data-testid="inspected-session-id">{inspectedNode.sessionId}</dd>
                    <dt>Canonical URI</dt>
                    <dd data-testid="inspected-session-uri">
                      <code>{inspectedNode.uri}</code>
                    </dd>
                    <dt>Parent Council Sessions</dt>
                    <dd data-testid="inspected-parent-sessions">
                      {inspectedNode.parentSessionIds && inspectedNode.parentSessionIds.length > 0
                        ? inspectedNode.parentSessionIds.join(", ")
                        : inspectedNode.parentSessionId ?? "None (Root)"}
                    </dd>
                    <dt>Role &amp; Status</dt>
                    <dd>
                      {inspectedNode.role} · {inspectedNode.status}
                      {inspectedNode.peerGroupId ? ` · Peer Group: ${inspectedNode.peerGroupId}` : ""}
                    </dd>
                    <dt>Harness &amp; Model</dt>
                    <dd>
                      {inspectedNode.harnessId} · {inspectedNode.modelId}
                    </dd>
                    <dt>Token Count</dt>
                    <dd>{inspectedNode.tokenCount.toLocaleString("en-US")} tokens</dd>
                    <dt>Live Transcript Summary</dt>
                    <dd>{inspectedNode.liveTranscriptSummary}</dd>
                  </dl>

                  {/* Direct User-to-Subagent Chat Panel */}
                  <div
                    className="session-dfs-explorer__direct-chat-box"
                    data-testid="direct-subagent-chat-panel"
                  >
                    <h4>
                      <MessageSquarePlus size={13} /> Direct Chat with {inspectedNode.sessionId} (
                      {inspectedNode.role})
                    </h4>
                    <div className="session-dfs-explorer__direct-chat-controls">
                      <input
                        type="text"
                        aria-label="Direct Subagent Chat Prompt"
                        placeholder={`Send a direct instruction to ${inspectedNode.sessionId} just like Main...`}
                        value={directSubagentPrompt}
                        onChange={(e) => setDirectSubagentPrompt(e.target.value)}
                        data-testid="direct-subagent-chat-input"
                      />
                      <button
                        type="button"
                        onClick={handleSendDirectSubagentPrompt}
                        data-testid="send-direct-subagent-chat-btn"
                      >
                        <Play size={12} /> Send to {inspectedNode.sessionId}
                      </button>
                    </div>
                    {inspectedNode.directChatTranscript &&
                    inspectedNode.directChatTranscript.length > 0 ? (
                      <ul
                        className="session-dfs-explorer__direct-chat-transcript"
                        data-testid="direct-subagent-chat-transcript"
                      >
                        {inspectedNode.directChatTranscript.map((turn) => (
                          <li key={turn.id} data-testid={`direct-chat-msg-${turn.id}`}>
                            <strong>[{turn.sender} · {turn.senderSessionId}]:</strong> {turn.content}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="sw-inspector-subgrid">
                    <div>
                      <h4>Key Findings</h4>
                      <ul>
                        {inspectedNode.keyFindings.map((finding, idx) => (
                          <li key={idx}>{finding}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4>Referenced Session URIs ({inspectedNode.referencedSessionUris.length})</h4>
                      <ul>
                        {inspectedNode.referencedSessionUris.map((refUri) => (
                          <li key={refUri}>
                            <code>{refUri}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Collapsible URI Resolver & External Thread Linker Drawer */}
              <details className="sw-accordion">
                <summary className="sw-accordion__summary" data-tooltip="Attach External Session URI to DFS Graph">
                  <Link2 size={13} /> <span>URI Resolver &amp; External Thread Linker</span>
                </summary>
                <form
                  className="session-dfs-explorer__linker sw-accordion__body"
                  onSubmit={handleAttachExternalUri}
                  aria-label="URI Resolver & External Thread Linker"
                  data-testid="uri-resolver-linker"
                >
                  <div className="session-dfs-explorer__linker-inputs">
                    <label htmlFor="external-session-uri-input">
                      External Session URI
                    </label>
                    <input
                      id="external-session-uri-input"
                      type="text"
                      placeholder="Paste codex://threads/... or omnia://sessions/... URI to attach"
                      value={externalUriInput}
                      onChange={(event) => setExternalUriInput(event.target.value)}
                      data-testid="external-session-uri-input"
                    />
                    <label htmlFor="link-parent-session-select">Attach Under Parent</label>
                    <select
                      id="link-parent-session-select"
                      value={linkTargetParentId}
                      onChange={(event) => setLinkTargetParentId(event.target.value)}
                      data-testid="link-parent-session-select"
                    >
                      {Object.keys(nodesById).map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                    <button type="submit" data-testid="attach-session-uri-btn">
                      <Link2 size={14} /> Attach URI to Session Graph
                    </button>
                  </div>
                </form>
              </details>

              {/* Compiled A->B->C DFS Digest Collapsible Preview */}
              <details className="sw-accordion" open={Boolean(compiledDigestResult)}>
                <summary className="sw-accordion__summary" data-tooltip="Preview Compiled A->B->C DFS Context Digest">
                  <FileCode2 size={13} />{" "}
                  <span>
                    Compiled A-&gt;B-&gt;C DFS Digest
                    {compiledDigestResult ? " (Snapshot Compiled)" : " (Live Preview)"}
                  </span>
                </summary>
                <div className="session-dfs-explorer__digest-panel sw-accordion__body" data-testid="compiled-dfs-digest-panel">
                  <div className="session-dfs-explorer__digest-header">
                    <button
                      type="button"
                      onClick={() => handleCopyLiveUri(displayedDigest.compiledContextMarkdown)}
                      data-testid="copy-compiled-digest-btn"
                      data-tooltip="Copy Markdown Digest to Clipboard"
                    >
                      <Copy size={13} /> Copy Compiled Digest
                    </button>
                  </div>
                  <pre data-testid="compiled-dfs-context-markdown">
                    {displayedDigest.compiledContextMarkdown}
                  </pre>
                </div>
              </details>
            </div>
          </details>

          {/* LAYER 2: Multi-Parent AI Council & Unlimited Swarm Spawner + Adaptive Spawn Policy Advisor */}
          <details
            open={activeLayer === "swarm-council"}
            className={`sw-accordion sw-layer-section ${activeLayer === "swarm-council" ? "is-focused-layer" : ""}`}
          >
            <summary className="sw-accordion__summary" data-tooltip="Configure Multi-Parent AI Council & Adaptive Unlimited Swarm">
              <Users size={14} /> <strong>2. Multi-Parent Council &amp; Swarm Spawner</strong>
            </summary>

            <div
              className="session-dfs-explorer__swarm-council-grid sw-accordion__body"
              data-testid="multi-parent-swarm-panel"
            >
              <details className="sw-accordion" open>
                <summary className="sw-accordion__summary">
                  <Users size={13} /> <span>Multi-Parent Council &amp; Swarm Spawner</span>
                </summary>
                <div className="session-dfs-explorer__council-box sw-accordion__body">
                  <div
                    className="session-dfs-explorer__parent-checkboxes"
                    role="group"
                    aria-label="Select Parent Council Sessions"
                  >
                    {Object.keys(nodesById).slice(0, 8).map((id) => (
                      <label key={id} className="session-dfs-explorer__parent-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedParentCouncilIds.includes(id)}
                          onChange={() => handleToggleParentCouncilMember(id)}
                          data-testid={`multi-parent-checkbox-${id}`}
                        />
                        <span>{id}</span>
                      </label>
                    ))}
                  </div>

                  <div className="session-dfs-explorer__council-actions">
                    <label>
                      Co-Supervised Child Node
                      <select
                        aria-label="Co-Supervised Child Node"
                        value={multiParentTargetChildId}
                        onChange={(e) => setMultiParentTargetChildId(e.target.value)}
                        data-testid="multi-parent-target-child-select"
                      >
                        {Object.keys(nodesById).map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      onClick={handleLinkMultiParentCouncil}
                      data-testid="link-multi-parent-btn"
                    >
                      <Users size={14} /> Link Multi-Parent Council
                    </button>
                  </div>

                  <div className="session-dfs-explorer__swarm-controls">
                    <label>
                      Swarm Count (Unlimited Cap)
                      <input
                        type="number"
                        min={1}
                        aria-label="Swarm Count"
                        value={swarmCountInput}
                        onChange={(e) => setSwarmCountInput(Math.max(1, Number(e.target.value) || 1))}
                        data-testid="swarm-count-input"
                      />
                    </label>

                    <label>
                      Recursive Children / Subagent
                      <input
                        type="number"
                        min={0}
                        aria-label="Recursive Children Per Subagent"
                        value={swarmChildrenPerAgent}
                        onChange={(e) => setSwarmChildrenPerAgent(Math.max(0, Number(e.target.value) || 0))}
                        data-testid="swarm-children-per-agent-input"
                      />
                    </label>

                    <label>
                      Swarm Base Title
                      <input
                        type="text"
                        aria-label="Swarm Base Title"
                        value={swarmBaseTitle}
                        onChange={(e) => setSwarmBaseTitle(e.target.value)}
                        data-testid="swarm-base-title-input"
                      />
                    </label>

                    <label>
                      Swarm Role
                      <select
                        aria-label="Swarm Role"
                        value={swarmRole}
                        onChange={(e) => setSwarmRole(e.target.value as SessionAgentRole)}
                        data-testid="swarm-role-select"
                      >
                        <option value="coder">coder</option>
                        <option value="researcher">researcher</option>
                        <option value="verifier">verifier</option>
                        <option value="subagent">subagent</option>
                      </select>
                    </label>

                    <button
                      type="button"
                      onClick={() => executeSwarmSpawn(swarmCountInput, swarmChildrenPerAgent)}
                      data-testid="spawn-custom-subagent-swarm-btn"
                    >
                      <PlusCircle size={14} /> Spawn {swarmCountInput}-Agent Swarm
                    </button>

                    <button
                      type="button"
                      onClick={() => executeSwarmSpawn(50, 0, "Massive 50-Agent Swarm Shard")}
                      data-testid="spawn-50-subagent-swarm-btn"
                    >
                      <Zap size={14} /> Spawn 50-Agent Swarm
                    </button>
                  </div>
                </div>
              </details>

              {/* Collapsible Adaptive Spawn Policy Advisor Widget */}
              <details
                className="session-dfs-explorer__policy-advisor sw-accordion"
                data-testid="adaptive-spawn-policy-widget"
              >
                <summary className="sw-accordion__summary">
                  <Zap size={13} /> <span>Adaptive Subagent Spawn Policy Advisor</span>
                </summary>
                <div className="sw-accordion__body">
                  <div className="session-dfs-explorer__policy-presets">
                    <button
                      type="button"
                      onClick={() => {
                        setPolicyWorkstreams(1);
                        setPolicyFilesToTouch(1);
                        setPolicyCouplingRatio(0.92);
                        setPolicyRequiresConsensus(false);
                        setPolicyRequestedMinAgents(0);
                      }}
                      data-testid="policy-preset-no-spawn-btn"
                      data-tooltip="Single-stream tightly-coupled task: 0 subagents"
                    >
                      0 Agents Direct
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPolicyWorkstreams(4);
                        setPolicyFilesToTouch(9);
                        setPolicyCouplingRatio(0.35);
                        setPolicyRequiresConsensus(false);
                        setPolicyRequestedMinAgents(0);
                      }}
                      data-testid="policy-preset-focused-squad-btn"
                      data-tooltip="Modular multi-file task: 4..6 focused squad"
                    >
                      4-6 Squad
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPolicyWorkstreams(45);
                        setPolicyFilesToTouch(120);
                        setPolicyCouplingRatio(0.1);
                        setPolicyRequiresConsensus(true);
                        setPolicyRequestedMinAgents(60);
                      }}
                      data-testid="policy-preset-massive-swarm-btn"
                      data-tooltip="Decoupled repository-wide migration: 50+ unlimited swarm"
                    >
                      50+ Unlimited Swarm
                    </button>
                  </div>

                  <div className="session-dfs-explorer__policy-inputs">
                    <label>
                      Task Description
                      <input
                        type="text"
                        aria-label="Policy Task Description"
                        value={policyTaskDescription}
                        onChange={(e) => setPolicyTaskDescription(e.target.value)}
                        data-testid="policy-task-input"
                      />
                    </label>

                    <label>
                      Independent Workstreams
                      <input
                        type="number"
                        min={1}
                        aria-label="Independent Workstreams"
                        value={policyWorkstreams}
                        onChange={(e) => setPolicyWorkstreams(Math.max(1, Number(e.target.value) || 1))}
                        data-testid="policy-workstreams-input"
                      />
                    </label>

                    <label>
                      Estimated Files to Touch
                      <input
                        type="number"
                        min={1}
                        aria-label="Estimated Files to Touch"
                        value={policyFilesToTouch}
                        onChange={(e) => setPolicyFilesToTouch(Math.max(1, Number(e.target.value) || 1))}
                        data-testid="policy-files-input"
                      />
                    </label>

                    <label>
                      Coupling Ratio (0.00 - 1.00)
                      <input
                        type="number"
                        step={0.05}
                        min={0}
                        max={1}
                        aria-label="Coupling Ratio"
                        value={policyCouplingRatio}
                        onChange={(e) =>
                          setPolicyCouplingRatio(Math.min(1, Math.max(0, Number(e.target.value) || 0)))
                        }
                        data-testid="policy-coupling-input"
                      />
                    </label>

                    <label>
                      Requested Min Agents (No Upper Cap)
                      <input
                        type="number"
                        min={0}
                        aria-label="Requested Min Agents"
                        value={policyRequestedMinAgents}
                        onChange={(e) =>
                          setPolicyRequestedMinAgents(Math.max(0, Number(e.target.value) || 0))
                        }
                        data-testid="policy-min-agents-input"
                      />
                    </label>

                    <label>
                      <input
                        type="checkbox"
                        checked={policyRequiresConsensus}
                        onChange={(e) => setPolicyRequiresConsensus(e.target.checked)}
                        data-testid="policy-consensus-checkbox"
                      />
                      Requires Multi-Model Parent Council Consensus
                    </label>
                  </div>

                  <div className="session-dfs-explorer__policy-result">
                    <strong data-testid="spawn-policy-decision-badge">
                      {policyDecision.shouldSpawnSubagents
                        ? `${policyDecision.recommendedCount} agents · ${policyDecision.strategyLabel} · ${policyDecision.recommendedParentCouncilCount} parent(s) · depth ${policyDecision.recommendedDepth} · Cap: UNLIMITED`
                        : `0 agents — Direct Execution (${policyDecision.strategyLabel})`}
                    </strong>
                    <p data-testid="spawn-policy-rationale">{policyDecision.rationale}</p>
                    {policyDecision.shouldSpawnSubagents ? (
                      <button
                        type="button"
                        onClick={() =>
                          executeSwarmSpawn(
                            policyDecision.recommendedCount,
                            policyDecision.recommendedChildrenPerSubagent,
                            `Policy ${policyDecision.strategyLabel} Agent`,
                          )
                        }
                        data-testid="apply-policy-spawn-btn"
                      >
                        <Play size={13} /> Apply Policy &amp; Spawn {policyDecision.recommendedCount} Subagents
                      </button>
                    ) : null}
                  </div>
                </div>
              </details>

              {/* Grouped k-d Tree Multi-Main & Peer-Discussion Subagent DAG ({A, B}, C) */}
              <details
                className="session-dfs-explorer__kd-tree-peer-group sw-accordion"
                data-testid="kd-tree-peer-group-panel"
                open
              >
                <summary className="sw-accordion__summary">
                  <GitBranch size={13} />{" "}
                  <span>
                    Grouped <code>k-d Tree</code> Peer-Discussion Subagent DAG (<code>{"{A, B}, C"}</code>)
                  </span>
                </summary>
                <div className="sw-accordion__body">
                  <div className="session-dfs-explorer__policy-inputs">
                    <label>
                      k-d Tree Peer Group Expression (e.g. <code>{"{session-b1, session-c1}, session-c2"}</code>)
                      <input
                        type="text"
                        aria-label="k-d Tree Peer Group Expression"
                        value={kdGroupExpression}
                        onChange={(e) => setKdGroupExpression(e.target.value)}
                        data-testid="kd-group-expression-input"
                      />
                    </label>
                    <label>
                      Peer Discussion &amp; DoD Verification Topic
                      <input
                        type="text"
                        aria-label="Peer Discussion Topic"
                        value={kdDiscussionTopic}
                        onChange={(e) => setKdDiscussionTopic(e.target.value)}
                        data-testid="kd-discussion-topic-input"
                      />
                    </label>
                  </div>
                  <div className="session-dfs-explorer__council-actions">
                    <button
                      type="button"
                      onClick={handlePartitionKdTreeGroups}
                      data-testid="partition-kd-tree-groups-btn"
                    >
                      <GitBranch size={13} /> Partition k-d Tree Groups ({"{A, B}, C"})
                    </button>
                    <button
                      type="button"
                      onClick={handleRunKdPeerDiscussion}
                      data-testid="run-kd-peer-discussion-btn"
                    >
                      <Users size={13} /> Run {"{A, B}"} Peer Discussion &amp; Report to Parent
                    </button>
                  </div>
                  {kdConsensusReports.length > 0 ? (
                    <div data-testid="kd-consensus-reports-list">
                      {kdConsensusReports.map((report) => (
                        <div key={report.groupId} className="sw-nextgen-card" data-testid={`kd-report-${report.groupId}`}>
                          <strong>
                            Group {report.notation} ({report.discussionTurns.length} peer exchange turns ·{" "}
                            {report.definitionOfDoneChecklist.length}/{report.definitionOfDoneChecklist.length} DoD verified)
                          </strong>
                          <pre className="sw-code-preview">{report.consolidatedParentReport}</pre>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          </details>

          {/* LAYER 3: Highlight Quote, Reply & /btw Ephemeral Side-Chat Drawer + Slash Command Bar */}
          <details
            open={activeLayer === "btw-sidechat"}
            className={`sw-accordion sw-layer-section ${activeLayer === "btw-sidechat" ? "is-focused-layer" : ""}`}
          >
            <summary className="sw-accordion__summary" data-tooltip="Highlight Quote, Reply, /btw Side-Chat & Cross-Harness Slash Commands">
              <Quote size={14} /> <strong>3. Quote, Reply &amp; Ephemeral <code>/btw</code> Side-Chat</strong>
            </summary>

            <div
              className="session-dfs-explorer__btw-studio sw-accordion__body"
              data-testid="selection-btw-studio"
            >
              <div className="session-dfs-explorer__btw-inputs">
                <label>
                  Highlighted / Selected Snippet (Auto-Captured on Text Selection)
                  <textarea
                    rows={2}
                    aria-label="Selected Snippet"
                    value={selectionQuoteText}
                    onChange={(e) => setSelectionQuoteText(e.target.value)}
                    data-testid="selection-quote-input"
                  />
                </label>

                <label>
                  Reply Comment / <code>/btw</code> Ephemeral Question
                  <input
                    type="text"
                    aria-label="Btw Question Input"
                    value={btwQuestionInput}
                    onChange={(e) => setBtwQuestionInput(e.target.value)}
                    data-testid="btw-question-input"
                  />
                </label>
              </div>

              <div className="session-dfs-explorer__btw-actions">
                <button
                  type="button"
                  onClick={handleQuoteSelectionInChat}
                  data-testid="selection-quote-to-chat-btn"
                  data-tooltip="Insert Markdown Blockquote into Active Chat"
                >
                  <Quote size={13} /> Quote in Active Chat (&gt; ...)
                </button>

                <button
                  type="button"
                  onClick={handleReplySelectionInChat}
                  data-testid="selection-reply-to-chat-btn"
                  data-tooltip="Insert Targeted Turn Reply into Active Chat"
                >
                  <MessageSquarePlus size={13} /> Reply to Turn
                </button>

                <button
                  type="button"
                  onClick={handleAskBtwSideChat}
                  data-testid="ask-btw-side-chat-btn"
                  data-tooltip="Resolve in Isolated /btw Buffer (Zero Main-Context Pollution)"
                >
                  <Sparkles size={13} /> Ask in /btw Side Chat
                </button>

                <button
                  type="button"
                  onClick={() => handlePromoteBtwToMainChat()}
                  data-testid="promote-btw-to-chat-btn"
                  data-tooltip="Promote Latest /btw Answer into Active Chat Composer"
                >
                  <FileCode2 size={13} /> Promote /btw Answer to Main Chat
                </button>
              </div>

              <ul className="session-dfs-explorer__btw-list" data-testid="btw-side-chat-list">
                {btwSideChatEntries.map((entry) => (
                  <li
                    key={entry.id}
                    className="session-dfs-explorer__btw-entry"
                    data-testid={`btw-entry-${entry.id}`}
                  >
                    <div>
                      <code>{entry.sourceSessionUri}</code> ·{" "}
                      <span>{entry.promotedToMainChat ? "Promoted to Main Chat" : "Ephemeral Side-Chat"}</span>
                    </div>
                    <blockquote>&gt; {entry.selectedQuote}</blockquote>
                    <p>
                      <strong>Q:</strong> {entry.question}
                    </p>
                    <p data-testid="btw-latest-answer">
                      <strong>A:</strong> {entry.answer}
                    </p>
                  </li>
                ))}
              </ul>

              {/* Compact Cross-Harness Slash Command Bar */}
              <div
                className="session-dfs-explorer__slash-bar"
                data-testid="cross-harness-slash-command-bar"
              >
                <h4>
                  <Terminal size={14} /> Cross-Harness Slash Commands ({CROSS_HARNESS_SLASH_COMMANDS.length})
                </h4>
                <div className="session-dfs-explorer__slash-buttons">
                  {CROSS_HARNESS_SLASH_COMMANDS.map((spec) => (
                    <button
                      key={spec.command}
                      type="button"
                      title={`${spec.title} — ${spec.description} (${spec.inspiredByHarnesses.join(", ")})`}
                      data-tooltip={`${spec.title} (${spec.mcpSkillBinding})`}
                      onClick={() => handleExecuteSlashCommand(spec)}
                      data-testid={`slash-cmd-btn-${spec.command.slice(1)}`}
                    >
                      <code>{spec.command}</code> <span>{spec.title}</span>
                    </button>
                  ))}
                </div>
                {slashCommandFeedback ? (
                  <p role="status" data-testid="slash-command-feedback">
                    {slashCommandFeedback}
                  </p>
                ) : null}
              </div>
            </div>
          </details>

          {/* LAYER 4: 2026 AI Architecture Telemetry (A2A Agent Cards, PRM Step Verifier & RadixAttention KV-Cache Tree) */}
          <details
            open={activeLayer === "nextgen-ai-2026"}
            className={`sw-accordion sw-layer-section ${activeLayer === "nextgen-ai-2026" ? "is-focused-layer" : ""}`}
          >
            <summary className="sw-accordion__summary" data-tooltip="A2A Agent Cards, MCP Streamable HTTP, PRM Step Verifier & RadixAttention KV-Cache Tree">
              <Cpu size={14} /> <strong>4. 2026 AI Architecture Telemetry (A2A · PRM · RadixAttention)</strong>
            </summary>

            <div
              className="session-dfs-explorer__nextgen-hub sw-accordion__body"
              data-testid="nextgen-ai-architecture-panel"
            >
              {/* 4A. RadixAttention Prefix KV-Cache Tree */}
              <div className="sw-nextgen-card" data-testid="radix-kv-cache-panel">
                <h4>
                  <Layers size={14} /> RadixAttention Shared Prefix KV-Cache Tree
                </h4>
                <div className="sw-nextgen-badges">
                  <span data-testid="radix-overall-sharing-badge">
                    {radixCacheTree.overallPrefixSharingPct}% Shared Prefix
                  </span>
                  <span data-testid="radix-ttft-saved-badge">
                    ~{radixCacheTree.estimatedTotalTtftSavedMs} ms TTFT Saved
                  </span>
                  <span>
                    {radixCacheTree.totalSharedPrefixTokens.toLocaleString("en-US")} /{" "}
                    {radixCacheTree.totalTokensAcrossSessions.toLocaleString("en-US")} Cached Tokens
                  </span>
                </div>
                <ul className="sw-radix-node-list" data-testid="radix-node-metrics-list">
                  {radixCacheTree.nodes.slice(0, 6).map((metric) => (
                    <li key={metric.sessionId} data-testid={`radix-node-metric-${metric.sessionId}`}>
                      <code>{metric.sessionId}</code> · <strong>{metric.prefixSharingPct}% shared</strong> (
                      {metric.sharedPrefixTokens.toLocaleString("en-US")} tok · -{metric.ttftReductionMs} ms TTFT) ·{" "}
                      <code>{metric.radixPrefixKey}</code>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 4B. PRM (Process Reward Model) Step-by-Step Reasoning Verifier & MCTS */}
              <div className="sw-nextgen-card" data-testid="prm-verifier-panel">
                <h4>
                  <ShieldCheck size={14} /> PRM Step-by-Step Reasoning Verifier &amp; MCTS Branch Pruner
                </h4>
                <div className="sw-nextgen-badges">
                  <span data-testid="prm-aggregate-score-badge">
                    Mean PRM Score: {prmEvaluation.aggregatePrmScore.toFixed(2)}
                  </span>
                  <span data-testid="prm-pruned-count-badge">
                    {prmEvaluation.prunedBranchCount} Branches Pruned
                  </span>
                  <span>
                    MCTS Path: [{prmEvaluation.recommendedMctsPath.join(" -> ")}]
                  </span>
                </div>
                <label>
                  Reasoning Steps Trace (1 step per line)
                  <textarea
                    rows={3}
                    aria-label="PRM Reasoning Steps Input"
                    value={prmStepsRawText}
                    onChange={(e) => setPrmStepsRawText(e.target.value)}
                    data-testid="prm-steps-textarea"
                  />
                </label>
                <ul className="sw-prm-steps-list" data-testid="prm-evaluated-steps-list">
                  {prmEvaluation.evaluatedSteps.map((step) => (
                    <li
                      key={step.stepIndex}
                      data-testid={`prm-step-item-${step.stepIndex}`}
                      className={`prm-verdict-${step.verdict}`}
                    >
                      <strong>Step #{step.stepIndex}</strong> · Score:{" "}
                      <code>{step.prmScore.toFixed(2)}</code> · Verdict:{" "}
                      <span data-testid={`prm-step-verdict-${step.stepIndex}`}>{step.verdict}</span> (
                      <code>{step.mctsAction}</code>) — {step.thought}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 4C. A2A Agent Cards & MCP 2026 Streamable HTTP Discovery */}
              <div className="sw-nextgen-card" data-testid="a2a-agent-cards-panel">
                <h4>
                  <Network size={14} /> A2A Agent Cards &amp; MCP 2026 Streamable HTTP Mesh
                </h4>
                <div className="sw-a2a-controls">
                  <label>
                    Target A2A AgentCard
                    <select
                      aria-label="Target A2A AgentCard"
                      value={selectedA2AAgentId}
                      onChange={(e) => setSelectedA2AAgentId(e.target.value)}
                      data-testid="a2a-agent-select"
                    >
                      {DEFAULT_A2A_AGENT_CARDS.map((card) => (
                        <option key={card.agentId} value={card.agentId}>
                          {card.name} ({card.authScheme})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    MCP 2026 Streamable HTTP Server
                    <select
                      aria-label="MCP Streamable HTTP Server"
                      value={selectedMcpServerId}
                      onChange={(e) => setSelectedMcpServerId(e.target.value)}
                      data-testid="mcp-streamable-server-select"
                    >
                      {DEFAULT_MCP_STREAMABLE_SERVERS.map((srv) => (
                        <option key={srv.serverId} value={srv.serverId}>
                          {srv.name} ({srv.transport})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    A2A Delegation Task Prompt
                    <input
                      type="text"
                      aria-label="A2A Delegation Task Prompt"
                      value={a2aTaskPrompt}
                      onChange={(e) => setA2aTaskPrompt(e.target.value)}
                      data-testid="a2a-task-prompt-input"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={handleDispatchA2AEnvelope}
                    data-testid="a2a-dispatch-envelope-btn"
                  >
                    <Play size={13} /> Dispatch A2A Streamable Envelope
                  </button>
                </div>

                <pre data-testid="a2a-envelope-preview" className="sw-code-preview">
                  {JSON.stringify(liveA2AEnvelopePreview, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        </aside>
      </div>
    </section>
  );
}

export default SessionDfsExplorer;
