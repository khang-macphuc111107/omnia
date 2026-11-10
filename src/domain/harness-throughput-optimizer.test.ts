import { describe, expect, it } from "vitest";
import {
  buildCacheStableProviderPayload,
  computeDeterministicHexHash256,
  computeStreamThroughputMetrics,
  createSovereignLocalPromptCache,
  createStreamDeltaCoalescer,
  FRAME_BUDGET_120FPS_MS,
  FRAME_BUDGET_60FPS_MS,
  reconcileProviderAndLocalCacheUsage,
  type CoalescedStreamFrameBatch,
} from "./harness-throughput-optimizer";

describe("harness-throughput-optimizer", () => {
  describe("createStreamDeltaCoalescer", () => {
    it("coalesces rapid 150+ tok/s deltas into 8ms (120fps) frame batches", () => {
      let currentTimeMs = 1_000;
      let scheduledCallback: (() => void) | null = null;
      let scheduledDelayMs: number | null = null;
      const flushedBatches: CoalescedStreamFrameBatch[] = [];

      const coalescer = createStreamDeltaCoalescer({
        frameBudgetMs: FRAME_BUDGET_120FPS_MS,
        now: () => currentTimeMs,
        scheduleTimer: (cb, delayMs) => {
          scheduledCallback = cb;
          scheduledDelayMs = delayMs;
          return 1;
        },
        cancelTimer: () => {
          scheduledCallback = null;
        },
        onFlush: (batch) => {
          flushedBatches.push(batch);
        },
      });

      // Simulate 12 tokens arriving within a single 8ms window (~1,500 tok/s burst)
      for (let i = 0; i < 12; i += 1) {
        currentTimeMs = 1_000 + Math.floor(i / 2);
        const immediate = coalescer.push({
          textDelta: `tok${i} `,
          reasoningDelta: i < 3 ? `r${i}` : "",
          sequence: i + 1,
        });
        expect(immediate).toBeNull();
      }

      expect(coalescer.isPending()).toBe(true);
      expect(scheduledDelayMs).toBe(8);
      expect(flushedBatches).toHaveLength(0);

      // Advance clock to 8ms frame boundary and fire timer
      currentTimeMs = 1_008;
      expect(scheduledCallback).not.toBeNull();
      scheduledCallback!();

      expect(coalescer.isPending()).toBe(false);
      expect(flushedBatches).toHaveLength(1);
      const batch = flushedBatches[0]!;
      expect(batch.batchSequence).toBe(0);
      expect(batch.textDelta).toBe(
        "tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7 tok8 tok9 tok10 tok11 ",
      );
      expect(batch.reasoningDelta).toBe("r0r1r2");
      expect(batch.coalescedDeltaCount).toBe(12);
      expect(batch.firstSourceSequence).toBe(1);
      expect(batch.lastSourceSequence).toBe(12);
      expect(batch.frameWindowMs).toBe(8);

      const stats = coalescer.getStats();
      expect(stats.rawDeltaCount).toBe(12);
      expect(stats.flushedBatchCount).toBe(1);
      expect(stats.estimatedStateClonesSaved).toBe(11);
      expect(stats.coalescedWriteRatio).toBeCloseTo(11 / 12, 5);
      expect(stats.coalescingCompressionFactor).toBe(12);
    });

    it("supports 60fps (16ms) targetFps preset and immediate threshold flushes", () => {
      let currentTimeMs = 5_000;
      const flushedBatches: CoalescedStreamFrameBatch[] = [];

      const coalescer = createStreamDeltaCoalescer({
        targetFps: 60,
        maxBatchDeltas: 4,
        now: () => currentTimeMs,
        scheduleTimer: () => 42,
        cancelTimer: () => {},
        onFlush: (batch) => {
          flushedBatches.push(batch);
        },
      });

      expect(coalescer.getStats().frameBudgetMs).toBe(FRAME_BUDGET_60FPS_MS);

      coalescer.pushTextDelta("A");
      coalescer.pushTextDelta("B");
      coalescer.pushTextDelta("C");
      expect(flushedBatches).toHaveLength(0);

      // 4th delta hits maxBatchDeltas=4 and flushes synchronously
      currentTimeMs = 5_003;
      const immediateBatch = coalescer.pushTextDelta("D");
      expect(immediateBatch).not.toBeNull();
      expect(immediateBatch?.textDelta).toBe("ABCD");
      expect(immediateBatch?.coalescedDeltaCount).toBe(4);
      expect(flushedBatches).toHaveLength(1);
    });

    it("flushes pending deltas on explicit flush() or dispose() and rejects post-dispose pushes", () => {
      const flushedBatches: CoalescedStreamFrameBatch[] = [];
      const coalescer = createStreamDeltaCoalescer({
        onFlush: (batch) => {
          flushedBatches.push(batch);
        },
      });

      coalescer.push("Hello ");
      coalescer.pushReasoningDelta("thinking...");
      coalescer.push("world!");

      const finalBatch = coalescer.dispose();
      expect(finalBatch).not.toBeNull();
      expect(finalBatch?.textDelta).toBe("Hello world!");
      expect(finalBatch?.reasoningDelta).toBe("thinking...");
      expect(flushedBatches).toHaveLength(1);

      expect(() => coalescer.push("after dispose")).toThrow(/disposed/);
    });
  });

  describe("buildCacheStableProviderPayload", () => {
    it("produces identical staticPrefixHash and prefixHash regardless of skill or tool registration order", () => {
      const payloadA = buildCacheStableProviderPayload({
        providerFamily: "vllm",
        model: "Qwen/Qwen2.5-Coder-32B-Instruct",
        systemInstructions: ["You are Omnia.", "Follow strict safety invariants."],
        skillHeaders: [
          { id: "skill-zeta", title: "Zeta", content: "Use zeta rules." },
          { id: "skill-alpha", title: "Alpha", content: "Use alpha rules." },
        ],
        tools: [
          {
            name: "write_file",
            description: "Write   a   file  \n  to   disk.",
            inputSchema: {
              type: "object",
              required: ["path", "content"],
              $comment: "internal developer note that should be stripped",
              properties: {
                path: { type: "string", description: "Target   path" },
                content: { type: "string", examples: ["hello"] },
              },
            },
          },
          {
            name: "read_file",
            description: "Read a file from disk.",
            inputSchema: {
              properties: {
                path: { description: "File path", type: "string" },
              },
              type: "object",
            },
          },
        ],
        messages: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "developer", content: "Additional static policy" },
          { role: "user", content: "Second question" },
        ],
        compactToolSchemas: true,
      });

      const payloadB = buildCacheStableProviderPayload({
        providerFamily: "vllm",
        model: "Qwen/Qwen2.5-Coder-32B-Instruct",
        systemInstructions: ["You are Omnia.", "Follow strict safety invariants."],
        // Reversed skill order
        skillHeaders: [
          { id: "skill-alpha", title: "Alpha", content: "Use alpha rules." },
          { id: "skill-zeta", title: "Zeta", content: "Use zeta rules." },
        ],
        // Reversed tool order and shuffled JSON schema key order
        tools: [
          {
            name: "read_file",
            description: "Read   a   file   from   disk.",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "File   path" },
              },
            },
          },
          {
            name: "write_file",
            description: "Write a file to disk.",
            inputSchema: {
              properties: {
                content: { type: "string" },
                path: { description: "Target path", type: "string" },
              },
              required: ["path", "content"],
              type: "object",
            },
          },
        ],
        messages: [
          { role: "developer", content: "Additional static policy" },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second question" },
        ],
        compactToolSchemas: true,
      });

      expect(payloadA.staticPrefixHash).toBe(payloadB.staticPrefixHash);
      expect(payloadA.prefixHash).toBe(payloadB.prefixHash);
      expect(payloadA.canonicalSystemBlock).toBe(payloadB.canonicalSystemBlock);
      expect(payloadA.canonicalTools).toEqual(payloadB.canonicalTools);
      expect(payloadA.estimatedToolSchemaBytesSaved).toBeGreaterThan(0);
      expect(payloadA.cacheBreakpoints.map((b) => b.target)).toEqual([
        "system",
        "tools",
        "conversation-prefix",
      ]);
      expect(payloadA.providerHints["prompt_cache_key"]).toBe(
        payloadB.providerHints["prompt_cache_key"],
      );
    });

    it("keeps staticPrefixHash invariant across multi-turn conversation growth", () => {
      const turn1 = buildCacheStableProviderPayload({
        providerFamily: "openai-compatible",
        model: "deepseek-v3",
        systemInstructions: ["Core system prompt"],
        messages: [{ role: "user", content: "Turn 1 user prompt" }],
      });

      const turn2 = buildCacheStableProviderPayload({
        providerFamily: "openai-compatible",
        model: "deepseek-v3",
        systemInstructions: ["Core system prompt"],
        messages: [
          { role: "user", content: "Turn 1 user prompt" },
          { role: "assistant", content: "Turn 1 assistant reply" },
          { role: "user", content: "Turn 2 user prompt" },
        ],
      });

      expect(turn1.staticPrefixHash).toBe(turn2.staticPrefixHash);
      expect(turn1.prefixHash).not.toBe(turn2.prefixHash);
      expect(computeDeterministicHexHash256("test")).toHaveLength(64);
    });
  });

  describe("computeStreamThroughputMetrics", () => {
    it("diagnoses IPC/SQLite bottleneck when per-token synchronous writes throttle throughput to ~20 tok/s", () => {
      // 200 tokens over 10 seconds = 20 tok/s, with 200 uncoalesced SQLite transactions
      const metrics = computeStreamThroughputMetrics({
        requestDispatchedAtMs: 0,
        firstTokenAtMs: 120,
        completedAtMs: 10_120,
        outputTokens: 200,
        inputTokens: 2_048,
        cachedInputTokens: 1_536,
        rawSseDeltaCount: 200,
        persistedSqliteBatchCount: 200,
        emittedIpcBatchCount: 200,
      });

      expect(metrics.tokensPerSecond).toBeCloseTo(20, 1);
      expect(metrics.meetsTargetThroughput).toBe(false);
      expect(metrics.coalescedWriteRatio).toBe(0);
      expect(metrics.estimatedSqliteTransactionsSaved).toBe(0);
      expect(metrics.kvCacheHitRatio).toBeCloseTo(0.75, 4);
      expect(metrics.bottleneckDiagnosis.primaryBottleneck).toBe("ipc-sqlite-bound");
      expect(metrics.bottleneckDiagnosis.isIpcSqliteBound).toBe(true);
      expect(metrics.bottleneckDiagnosis.severity).toBe("critical");
      expect(metrics.bottleneckDiagnosis.recommendations.length).toBeGreaterThan(0);
    });

    it("verifies 150+ tok/s optimal throughput when SSE chunks and frame deltas are coalesced", () => {
      // 240 tokens over 1,200ms decode window = 200 tok/s, coalesced from 240 SSE frames into 15 batches
      const samples = Array.from({ length: 240 }, (_, index) => ({
        timestampMs: 80 + index * 5,
        tokenCount: 1,
      }));

      const metrics = computeStreamThroughputMetrics({
        requestDispatchedAtMs: 0,
        firstTokenAtMs: 80,
        completedAtMs: 1_280,
        outputTokens: 240,
        inputTokens: 4_096,
        cachedInputTokens: 3_584,
        rawSseDeltaCount: 240,
        persistedSqliteBatchCount: 15,
        emittedIpcBatchCount: 15,
        tokenSamples: samples,
      });

      expect(metrics.tokensPerSecond).toBe(200);
      expect(metrics.instantTokensPerSecond).toBe(200);
      expect(metrics.rollingWindowTokensPerSecond).toBe(200);
      expect(metrics.timeToFirstTokenMs).toBe(80);
      expect(metrics.interTokenLatencyMs).toBe(5);
      expect(metrics.coalescedWriteRatio).toBeCloseTo(225 / 240, 5);
      expect(metrics.coalescingCompressionFactor).toBe(16);
      expect(metrics.estimatedSqliteTransactionsSaved).toBe(225);
      expect(metrics.estimatedIpcEventsSaved).toBe(225);
      expect(metrics.kvCacheHitRatio).toBeCloseTo(0.875, 4);
      expect(metrics.meetsTargetThroughput).toBe(true);
      expect(metrics.bottleneckDiagnosis.primaryBottleneck).toBe("none");
      expect(metrics.bottleneckDiagnosis.severity).toBe("optimal");
    });

    it("diagnoses network-bound jitter and prefill-bound TTFT accurately", () => {
      // High jitter samples: mostly 6ms but periodic 80ms TCP delayed-ACK stalls
      const jitterSamples = Array.from({ length: 40 }, (_, index) => ({
        timestampMs: 100 + index * 6 + (index >= 35 ? (index - 34) * 60 : 0),
        tokenCount: 1,
      }));

      const networkMetrics = computeStreamThroughputMetrics({
        requestDispatchedAtMs: 0,
        firstTokenAtMs: 100,
        completedAtMs: jitterSamples[jitterSamples.length - 1]!.timestampMs,
        outputTokens: 40,
        rawSseDeltaCount: 40,
        persistedSqliteBatchCount: 8,
        tokenSamples: jitterSamples,
      });

      expect(networkMetrics.bottleneckDiagnosis.primaryBottleneck).toBe("network-bound");
      expect(networkMetrics.bottleneckDiagnosis.isNetworkBound).toBe(true);

      const prefillMetrics = computeStreamThroughputMetrics({
        requestDispatchedAtMs: 0,
        firstTokenAtMs: 2_500,
        completedAtMs: 3_500,
        outputTokens: 180,
        inputTokens: 8_192,
        cachedInputTokens: 0,
        rawSseDeltaCount: 180,
        persistedSqliteBatchCount: 12,
      });

      expect(prefillMetrics.tokensPerSecond).toBe(180);
      expect(prefillMetrics.meetsTargetThroughput).toBe(true);
      expect(prefillMetrics.bottleneckDiagnosis.primaryBottleneck).toBe("ttft-prefill-bound");
      expect(prefillMetrics.bottleneckDiagnosis.isPrefillBound).toBe(true);
      expect(prefillMetrics.bottleneckDiagnosis.severity).toBe("warning");
    });
  });

  describe("createSovereignLocalPromptCache & reconcileProviderAndLocalCacheUsage", () => {
    it("caches static prefixes, multi-turn history prefixes, and exact turn responses locally when upstream provider cache is broken", () => {
      const cache = createSovereignLocalPromptCache({
        persistToStorage: false,
        maxEntries: 64,
      });

      const systemInstructions = [
        "You are Omnia Sovereign Coding Architect.",
        "Always verify deterministic calculations and preserve KV-cache stability.",
      ];

      // Turn 1: initial lookup is a cache miss, then we record the completed turn
      const turn1Input = {
        model: "claude-opus-5-5",
        systemInstructions,
        messages: [{ role: "user" as const, content: "Design the local prompt cache engine." }],
      };

      const lookup1 = cache.lookup(turn1Input);
      expect(lookup1.hitKind).toBe("cache-miss");
      expect(lookup1.localCachedTokens).toBe(0);

      cache.recordCompletedTurn(turn1Input, {
        responseText: "Here is the deterministic SHA-256 local prompt and prefix cache architecture.",
        reasoningText: "Verified prefix hash invariance.",
      });

      // Repeating Turn 1 hits the exact response cache (100% hit ratio)
      const repeatLookup = cache.lookup(turn1Input);
      expect(repeatLookup.hitKind).toBe("exact-response-hit");
      expect(repeatLookup.cachedResponseText).toContain("SHA-256 local prompt");
      expect(repeatLookup.localCacheHitRatio).toBe(1);

      // Turn 2 in the same conversation hits the history prefix cache!
      const turn2Input = {
        model: "claude-opus-5-5",
        systemInstructions,
        messages: [
          { role: "user" as const, content: "Design the local prompt cache engine." },
          {
            role: "assistant" as const,
            content: "Here is the deterministic SHA-256 local prompt and prefix cache architecture.",
          },
          { role: "user" as const, content: "Now add broken-provider fallback reconciliation." },
        ],
      };

      const lookup2 = cache.lookup(turn2Input);
      expect(lookup2.hitKind).toBe("history-prefix-hit");
      expect(lookup2.localCachedTokens).toBeGreaterThan(0);
      expect(lookup2.localCacheHitRatio).toBeGreaterThan(0.5);

      // Even if upstream custom provider reports cachedInputTokens: 0, Omnia reconciles usage via local fallback cache!
      const reconciled = reconcileProviderAndLocalCacheUsage(lookup2, {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 0,
      });
      expect(reconciled.providerCacheBrokenFallbackApplied).toBe(true);
      expect(reconciled.cacheSource).toBe("omnia-local-fallback-cache");
      expect(reconciled.effectiveCachedInputTokens).toBe(lookup2.localCachedTokens);
      expect(reconciled.effectiveCacheHitRatio).toBeGreaterThan(0);

      const stats = cache.getStats();
      expect(stats.exactHitCount).toBe(1);
      expect(stats.prefixHitCount).toBe(1);
      expect(stats.totalTokensSavedByLocalCache).toBeGreaterThan(0);
    });
  });
});

