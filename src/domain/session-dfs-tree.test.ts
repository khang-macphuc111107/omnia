import { describe, expect, it } from "vitest";

import {
  CROSS_HARNESS_SLASH_COMMANDS,
  DEFAULT_A2A_AGENT_CARDS,
  DEFAULT_MCP_STREAMABLE_SERVERS,
  attachReferencedSessionUriToGraph,
  buildA2ATaskDelegationEnvelope,
  computeRadixKvCacheTree,
  createBtwSideChatTurn,
  createDefaultDfsSessionGraph,
  createLiveSessionNode,
  evaluateReasoningStepsWithPrm,
  evaluateSubagentSpawnPolicy,
  extractLiveSessionUris,
  formatAllLiveSessionUris,
  formatLiveSessionUri,
  formatSelectionQuoteReply,
  linkMultipleParentsToSession,
  parseLiveSessionUri,
  queryHippoRagAssociativeGraph,
  spawnChildSessionInGraph,
  spawnRecursiveSubagentSwarm,
  traverseSessionTreeDfs,
  tryParseLiveSessionUri,
} from "./session-dfs-tree";

describe("session-dfs-tree domain", () => {
  describe("copyable live session URIs", () => {
    it("formats and parses canonical omnia, codex, claude, and agy session URIs", () => {
      expect(formatLiveSessionUri("sess-alpha", "omnia")).toBe("omnia://sessions/sess-alpha");
      expect(formatLiveSessionUri("thread-42", "codex")).toBe("codex://threads/thread-42");
      expect(formatLiveSessionUri("claude-99", "claude")).toBe("claude://sessions/claude-99");
      expect(formatLiveSessionUri("conv-7", "agy")).toBe("agy://conversations/conv-7");
      expect(formatLiveSessionUri({ sessionId: "sess-obj", scheme: "codex" })).toBe("codex://threads/sess-obj");

      expect(parseLiveSessionUri("omnia://sessions/sess-alpha")).toEqual({
        uri: "omnia://sessions/sess-alpha",
        scheme: "omnia",
        namespace: "sessions",
        sessionId: "sess-alpha",
        defaultHarnessId: "custom-cache-first",
      });

      expect(parseLiveSessionUri("codex://threads/thread-42")).toEqual({
        uri: "codex://threads/thread-42",
        scheme: "codex",
        namespace: "threads",
        sessionId: "thread-42",
        defaultHarnessId: "openai-gpt-codex",
      });

      expect(parseLiveSessionUri("claude://sessions/claude-99")).toEqual({
        uri: "claude://sessions/claude-99",
        scheme: "claude",
        namespace: "sessions",
        sessionId: "claude-99",
        defaultHarnessId: "anthropic-claude-code",
      });

      expect(parseLiveSessionUri("agy://conversations/conv-7")).toEqual({
        uri: "agy://conversations/conv-7",
        scheme: "agy",
        namespace: "conversations",
        sessionId: "conv-7",
        defaultHarnessId: "google-gemini-agy",
      });
    });

    it("formats all 4 URI variants and extracts inline URIs from transcript text", () => {
      const bundle = formatAllLiveSessionUris("session-a");
      expect(bundle).toEqual({
        sessionId: "session-a",
        omnia: "omnia://sessions/session-a",
        codex: "codex://threads/session-a",
        claude: "claude://sessions/session-a",
        agy: "agy://conversations/session-a",
      });

      const extracted = extractLiveSessionUris(
        "Parent omnia://sessions/A delegated to codex://threads/B and claude://sessions/C then agy://conversations/D.",
      );
      expect(extracted).toEqual([
        "omnia://sessions/A",
        "codex://threads/B",
        "claude://sessions/C",
        "agy://conversations/D",
      ]);
    });

    it("rejects malformed URIs, wrong namespaces, path traversal, and secret-like IDs", () => {
      expect(() => parseLiveSessionUri("https://example.com/sessions/1")).toThrow(/Invalid live session URI/);
      expect(() => parseLiveSessionUri("codex://sessions/wrong-namespace")).toThrow(/Invalid namespace/);
      expect(() => formatLiveSessionUri("../escape", "omnia")).toThrow(/Invalid session ID/);
      expect(() => formatLiveSessionUri("sk-secret-token-123", "omnia")).toThrow(/secret credential/);
      expect(tryParseLiveSessionUri("invalid://uri")).toBeNull();
    });
  });

  describe("recursive pre-order DFS session graph (A -> B -> C)", () => {
    it("traverses explicit children and cross-referenced URIs in deterministic Pre-Order DFS (A -> B1 -> C1 -> C2 -> B2)", () => {
      const graph = createDefaultDfsSessionGraph();
      const result = traverseSessionTreeDfs("session-a", graph);

      expect(result.steps.map((step) => step.node.sessionId)).toEqual([
        "session-a",
        "session-b1",
        "session-c1",
        "session-c2",
        "session-b2",
      ]);

      expect(result.steps.map((step) => ({
        id: step.node.sessionId,
        depth: step.depth,
        dfsIndex: step.dfsIndex,
        pathFromRoot: step.pathFromRoot,
      }))).toEqual([
        { id: "session-a", depth: 0, dfsIndex: 0, pathFromRoot: ["session-a"] },
        { id: "session-b1", depth: 1, dfsIndex: 1, pathFromRoot: ["session-a", "session-b1"] },
        { id: "session-c1", depth: 2, dfsIndex: 2, pathFromRoot: ["session-a", "session-b1", "session-c1"] },
        { id: "session-c2", depth: 2, dfsIndex: 3, pathFromRoot: ["session-a", "session-b1", "session-c2"] },
        { id: "session-b2", depth: 1, dfsIndex: 4, pathFromRoot: ["session-a", "session-b2"] },
      ]);

      // session-c1 references omnia://sessions/session-a which is a cycle back to root
      expect(result.cycleEdgesSkipped).toEqual([
        {
          fromSessionId: "session-c1",
          toSessionId: "session-a",
          via: "uri-reference",
          uri: "omnia://sessions/session-a",
        },
      ]);

      expect(result.totalTokensAggregated).toBe(8420 + 6310 + 4890 + 3750 + 5120);
      expect(result.compiledContextMarkdown).toContain("session-a -> session-b1 -> session-c1 -> session-c2 -> session-b2");
      expect(result.compiledContextMarkdown).toContain("[DFS #2] session-a -> session-b1 -> session-c1");
    });

    it("resolves pure URI-reference chains when Session A mentions codex://threads/B and B mentions codex://threads/C", () => {
      const nodeA = createLiveSessionNode({
        sessionId: "A",
        uri: "omnia://sessions/A",
        title: "Root Session A",
        role: "main",
        status: "running",
        tokenCount: 1000,
        liveTranscriptSummary: "Inspecting upstream thread codex://threads/B for context.",
        referencedSessionUris: ["codex://threads/B"],
      });
      const nodeB = createLiveSessionNode({
        sessionId: "B",
        uri: "codex://threads/B",
        title: "Middle Thread B",
        role: "researcher",
        status: "running",
        tokenCount: 2000,
        liveTranscriptSummary: "Delegating verification to codex://threads/C.",
        referencedSessionUris: ["codex://threads/C"],
      });
      const nodeC = createLiveSessionNode({
        sessionId: "C",
        uri: "codex://threads/C",
        title: "Leaf Thread C",
        role: "verifier",
        status: "completed",
        tokenCount: 3000,
        liveTranscriptSummary: "Completed verification; citing omnia://sessions/A.",
        referencedSessionUris: ["omnia://sessions/A"],
      });

      const result = traverseSessionTreeDfs("A", { A: nodeA, B: nodeB, C: nodeC });
      expect(result.steps.map((s) => s.node.sessionId)).toEqual(["A", "B", "C"]);
      expect(result.steps[2]?.pathFromRoot).toEqual(["A", "B", "C"]);
      expect(result.steps[2]?.depth).toBe(2);
      expect(result.totalTokensAggregated).toBe(6000);
      expect(result.cycleEdgesSkipped).toHaveLength(1);
      expect(result.cycleEdgesSkipped[0]).toMatchObject({
        fromSessionId: "C",
        toSessionId: "A",
        via: "uri-reference",
      });
    });

    it("honors maxDepth and includeLiveStreaming options", () => {
      const graph = createDefaultDfsSessionGraph();

      const depth1Result = traverseSessionTreeDfs("session-a", graph, { maxDepth: 1 });
      expect(depth1Result.steps.map((s) => s.node.sessionId)).toEqual([
        "session-a",
        "session-b1",
        "session-b2",
      ]);

      // When includeLiveStreaming is false, running child nodes (session-b1, session-c2) are skipped,
      // while completed nodes reachable from root (session-b2) are still traversed if root is completed or when settled
      const settledGraph = {
        ...graph,
        "session-a": createLiveSessionNode({
          ...graph["session-a"]!,
          status: "completed",
        }),
      };
      const settledResult = traverseSessionTreeDfs("session-a", settledGraph, {
        includeLiveStreaming: false,
      });
      expect(settledResult.steps.map((s) => s.node.sessionId)).toEqual([
        "session-a",
        "session-b2",
      ]);
    });

    it("supports attaching external session URIs and spawning child sub-sessions in the graph", () => {
      const initialGraph = createDefaultDfsSessionGraph();
      const withExternal = attachReferencedSessionUriToGraph(
        initialGraph,
        "session-c1",
        "codex://threads/session-d1",
      );
      expect(withExternal["session-d1"]?.uri).toBe("codex://threads/session-d1");

      const { nodesById: withChild, childNode } = spawnChildSessionInGraph(withExternal, {
        parentSessionId: "session-d1",
        childSessionId: "session-e1",
        role: "verifier",
      });
      expect(childNode.sessionId).toBe("session-e1");

      const traversal = traverseSessionTreeDfs("session-a", withChild);
      expect(traversal.steps.map((s) => s.node.sessionId)).toEqual([
        "session-a",
        "session-b1",
        "session-c1",
        "session-d1",
        "session-e1",
        "session-c2",
        "session-b2",
      ]);
      const stepE1 = traversal.steps.find((s) => s.node.sessionId === "session-e1");
      expect(stepE1?.pathFromRoot).toEqual([
        "session-a",
        "session-b1",
        "session-c1",
        "session-d1",
        "session-e1",
      ]);
    });
  });

  describe("multi-parent AI council DAG and unlimited recursive subagent swarm", () => {
    it("links multiple parent sessions to a shared child subagent (Multi-Parent AI Council -> Child)", () => {
      const baseGraph = createDefaultDfsSessionGraph();
      const updated = linkMultipleParentsToSession(baseGraph, "session-c1", [
        "session-a",
        "session-b1",
        "session-b2",
      ]);

      expect(updated["session-c1"]?.parentSessionIds).toEqual([
        "session-b1",
        "session-a",
        "session-b2",
      ]);
      expect(updated["session-a"]?.childSessionIds).toContain("session-c1");
      expect(updated["session-b1"]?.childSessionIds).toContain("session-c1");
      expect(updated["session-b2"]?.childSessionIds).toContain("session-c1");

      const traversal = traverseSessionTreeDfs("session-a", updated);
      expect(traversal.compiledContextMarkdown).toContain(
        "Multi-Parent AI Council**: `session-b1`, `session-a`, `session-b2`",
      );
    });

    it("spawns recursive subagent swarms with zero upper cap (e.g., 5x3 recursive and 200+ agents)", () => {
      const baseGraph = createDefaultDfsSessionGraph();

      const recursiveSwarm = spawnRecursiveSubagentSwarm({
        nodesById: baseGraph,
        parentSessionIds: ["session-a", "session-b1"],
        count: 5,
        baseTitle: "Council Verification Shard",
        role: "verifier",
        childrenPerSubagent: 3,
      });

      expect(recursiveSwarm.spawnedSubagentIds).toHaveLength(5);
      expect(recursiveSwarm.spawnedGrandchildIds).toHaveLength(15);
      expect(recursiveSwarm.totalSpawnedCount).toBe(20);

      const firstSubagentId = recursiveSwarm.spawnedSubagentIds[0]!;
      const firstSubagent = recursiveSwarm.nodesById[firstSubagentId]!;
      expect(firstSubagent.parentSessionIds).toEqual(["session-a", "session-b1"]);
      expect(firstSubagent.childSessionIds).toHaveLength(3);

      // Verify zero upper cap by spawning 200 parallel subagents
      const massiveSwarm = spawnRecursiveSubagentSwarm({
        nodesById: baseGraph,
        parentSessionIds: ["session-a"],
        count: 200,
        baseTitle: "Massive Audit Agent",
        role: "coder",
        childrenPerSubagent: 0,
      });
      expect(massiveSwarm.spawnedSubagentIds).toHaveLength(200);
      expect(Object.keys(massiveSwarm.nodesById).length).toBe(205);
    });
  });

  describe("adaptive subagent spawn policy engine (unlimited cap)", () => {
    it("recommends NOT spawning subagents (0 agents) when work is tightly coupled and single-stream", () => {
      const decision = evaluateSubagentSpawnPolicy({
        taskDescription: "Fix single-line typo in button label",
        independentWorkstreams: 1,
        estimatedFilesToTouch: 1,
        couplingRatio: 0.92,
        requiresMultiModelConsensus: false,
      });

      expect(decision.shouldSpawnSubagents).toBe(false);
      expect(decision.recommendedCount).toBe(0);
      expect(decision.maxSubagentCap).toBeNull();
      expect(decision.strategyLabel).toBe("single-agent-direct");
    });

    it("scales dynamically from focused squad to multi-parent council DAG to massive unlimited swarm (50..500+)", () => {
      const squad = evaluateSubagentSpawnPolicy({
        taskDescription: "Update 3 independent UI widgets",
        independentWorkstreams: 3,
        estimatedFilesToTouch: 6,
        couplingRatio: 0.3,
        requiresMultiModelConsensus: false,
      });
      expect(squad.shouldSpawnSubagents).toBe(true);
      expect(squad.recommendedCount).toBeGreaterThanOrEqual(3);
      expect(squad.recommendedCount).toBeLessThan(8);
      expect(squad.strategyLabel).toBe("focused-squad");
      expect(squad.maxSubagentCap).toBeNull();

      const council = evaluateSubagentSpawnPolicy({
        taskDescription: "Cross-verify security boundary with multiple AI parent models",
        independentWorkstreams: 4,
        estimatedFilesToTouch: 10,
        couplingRatio: 0.25,
        requiresMultiModelConsensus: true,
      });
      expect(council.shouldSpawnSubagents).toBe(true);
      expect(council.recommendedParentCouncilCount).toBeGreaterThanOrEqual(2);
      expect(council.strategyLabel).toBe("multi-parent-council-dag");

      const massive = evaluateSubagentSpawnPolicy({
        taskDescription: "Migrate 300 microservices in parallel",
        independentWorkstreams: 120,
        estimatedFilesToTouch: 360,
        couplingRatio: 0.05,
        requiresMultiModelConsensus: true,
        requestedMinAgents: 250,
      });
      expect(massive.shouldSpawnSubagents).toBe(true);
      expect(massive.recommendedCount).toBeGreaterThanOrEqual(250);
      expect(massive.recommendedParentCouncilCount).toBe(4);
      expect(massive.recommendedDepth).toBe(4);
      expect(massive.strategyLabel).toBe("massive-unlimited-swarm");
      expect(massive.maxSubagentCap).toBeNull();
    });
  });

  describe("selection quote, reply, /btw ephemeral side-chat, and cross-harness slash commands", () => {
    it("creates isolated /btw side-chat turns and formats selection quotes/replies", () => {
      const btwTurn = createBtwSideChatTurn({
        selectedQuote: "Eliminated mid-prompt dynamic timestamps",
        sourceSessionUri: "claude://sessions/session-c1",
        question: "Why does dynamic timestamp placement break prefix caching?",
        activeSessionContext: "Anthropic 4-breakpoint cache layout",
      });

      expect(btwTurn.promotedToMainChat).toBe(false);
      expect(btwTurn.sourceSessionUri).toBe("claude://sessions/session-c1");
      expect(btwTurn.answer).toContain("Zero Main-Context Pollution");

      const quoteFormatted = formatSelectionQuoteReply({
        selectedText: "Line 1\nLine 2",
        sourceSessionUri: "omnia://sessions/session-a",
        replyComment: "Please verify these two lines.",
        mode: "quote",
      });
      expect(quoteFormatted).toContain("[Quote from omnia://sessions/session-a]");
      expect(quoteFormatted).toContain("> Line 1\n> Line 2");

      const replyFormatted = formatSelectionQuoteReply({
        selectedText: "Benchmark result: 185 tok/s",
        sourceSessionUri: "codex://threads/session-b1",
        replyComment: "Re-run with batch size 16",
        mode: "targeted-reply",
      });
      expect(replyFormatted).toContain("[Targeted Reply -> codex://threads/session-b1]");

      const commandNames = CROSS_HARNESS_SLASH_COMMANDS.map((c) => c.command);
      expect(commandNames).toEqual(
        expect.arrayContaining([
          "/btw",
          "/quote",
          "/reply",
          "/spawn",
          "/council",
          "/dfs",
          "/verify",
          "/calc",
          "/browser",
          "/idm",
          "/ide",
          "/remote",
          "/uncensored",
          "/ltst",
          "/a2a",
          "/prm",
          "/radix",
          "/hipporag",
        ]),
      );
      expect(CROSS_HARNESS_SLASH_COMMANDS.length).toBeGreaterThanOrEqual(18);
    });
  });

  describe("2026 AI Architectures: A2A Protocol, PRM Verifier, RadixAttention KV-Cache & HippoRAG", () => {
    it("builds A2A task delegation envelopes bound to MCP 2026 Streamable HTTP servers", () => {
      const targetCard = DEFAULT_A2A_AGENT_CARDS[0]!;
      const mcpServer = DEFAULT_MCP_STREAMABLE_SERVERS[0]!;

      const envelope = buildA2ATaskDelegationEnvelope({
        senderSessionUri: "omnia://sessions/session-a",
        targetAgentCard: targetCard,
        taskPrompt: "Audit RadixAttention shared prefix blocks across multi-parent council.",
        mcpServer,
      });

      expect(envelope.protocolVersion).toBe("A2A-2026.1+MCP-Streamable-HTTP");
      expect(envelope.senderSessionUri).toBe("omnia://sessions/session-a");
      expect(envelope.targetAgentId).toBe(targetCard.agentId);
      expect(envelope.streamingSupported).toBe(true);
      expect(envelope.mcpStreamableBinding.transport).toBe("streamable-http");
      expect(envelope.mcpStreamableBinding.dynamicToolDiscovery).toBe(true);
      expect(envelope.taskPayload.invokedSkills).toEqual(targetCard.skills);
    });

    it("evaluates multi-step reasoning traces with PRM (Process Reward Model) and prunes hallucination branches", () => {
      const result = evaluateReasoningStepsWithPrm({
        sessionId: "session-b1",
        steps: [
          "Verified 4-breakpoint immutable KV-cache prefix layout against Anthropic schema.",
          "Guess without checking and skip test suite to save time.",
          "Maybe we need to check if batch size 32 fits in 4096 MiB VRAM.",
          "Confirmed deterministic pre-order DFS cycle guard with vitest.",
        ],
      });

      expect(result.sessionId).toBe("session-b1");
      expect(result.evaluatedSteps).toHaveLength(4);
      expect(result.evaluatedSteps[0]?.verdict).toBe("valid");
      expect(result.evaluatedSteps[0]?.mctsAction).toBe("expand");
      expect(result.evaluatedSteps[1]?.verdict).toBe("backtrack-branch");
      expect(result.evaluatedSteps[1]?.mctsAction).toBe("prune-and-backtrack");
      expect(result.evaluatedSteps[2]?.verdict).toBe("tool-verify-required");
      expect(result.evaluatedSteps[2]?.mctsAction).toBe("invoke-verifier-tool");
      expect(result.evaluatedSteps[3]?.verdict).toBe("valid");
      expect(result.prunedBranchCount).toBe(1);
      expect(result.toolVerificationRequiredCount).toBe(1);
      expect(result.validStepCount).toBe(2);
      expect(result.recommendedMctsPath).toEqual([0, 2, 3]);
    });

    it("computes RadixAttention shared KV-cache prefix tree metrics and TTFT reduction across sessions", () => {
      const baseGraph = createDefaultDfsSessionGraph();
      const councilGraph = linkMultipleParentsToSession(baseGraph, "session-c1", [
        "session-a",
        "session-b1",
      ]);

      const radix = computeRadixKvCacheTree(councilGraph, { rootSessionId: "session-a" });
      expect(radix.rootSessionId).toBe("session-a");
      expect(radix.nodes.length).toBe(5);
      expect(radix.overallPrefixSharingPct).toBeGreaterThan(45);
      expect(radix.estimatedTotalTtftSavedMs).toBeGreaterThan(400);

      const c1Metric = radix.nodes.find((n) => n.sessionId === "session-c1");
      expect(c1Metric).toBeDefined();
      expect(c1Metric?.parentSessionIds).toEqual(["session-b1", "session-a"]);
      expect(c1Metric?.radixPrefixKey).toContain("session-b1+session-a->session-c1");
    });

    it("executes HippoRAG Personalized PageRank multi-hop associative retrieval across LTST nodes", () => {
      const nodes = [
        {
          id: "node-arch-kv-prefix",
          title: "Immutable Prefix KV-Cache Ring",
          folderPath: "/architecture",
          content: "Freeze system instructions and tool schemas at prefix slot 0 for 150+ tok/s.",
          confidence: 0.98,
          provenanceUris: ["omnia://sessions/session-a"],
        },
        {
          id: "node-bug-flat-memory-drift",
          title: "Postmortem: Flat MEMORY.md Cache Busting",
          folderPath: "/bug-postmortems",
          content: "Rewriting flat MEMORY.md invalidated prefix caches on every turn.",
          confidence: 0.92,
          provenanceUris: ["claude://sessions/session-c1"],
        },
        {
          id: "node-pref-strict-ts",
          title: "Strict TypeScript Governance",
          folderPath: "/user-preferences",
          content: "Enforce exactOptionalPropertyTypes and structured LTST nodes.",
          confidence: 0.95,
          provenanceUris: ["omnia://sessions/session-a"],
        },
      ];

      const edges = [
        {
          sourceNodeId: "node-arch-kv-prefix",
          targetNodeId: "node-bug-flat-memory-drift",
          relation: "supersedes",
        },
        {
          sourceNodeId: "node-bug-flat-memory-drift",
          targetNodeId: "node-pref-strict-ts",
          relation: "contradicts",
        },
      ];

      const hippoResult = queryHippoRagAssociativeGraph({
        query: "KV-Cache prefix slot 0",
        nodes,
        edges,
        maxHops: 2,
      });

      expect(hippoResult.seedNodeIds).toContain("node-arch-kv-prefix");
      expect(hippoResult.rankedNodes[0]?.nodeId).toBe("node-arch-kv-prefix");
      expect(hippoResult.rankedNodes[0]?.pprScore).toBe(1);
      expect(hippoResult.multiHopEdgesTraversed).toBeGreaterThanOrEqual(2);
      // Verify 2-hop associative propagation reached node-pref-strict-ts even without direct lexical overlap
      const twoHopNode = hippoResult.rankedNodes.find((n) => n.nodeId === "node-pref-strict-ts");
      expect(twoHopNode?.pprScore).toBeGreaterThan(0);
    });
  });
});


