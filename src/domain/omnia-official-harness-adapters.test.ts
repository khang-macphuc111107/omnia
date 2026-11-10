import { describe, expect, it } from "vitest";

import {
  createBuiltInOfficialHarnessAdapters,
  createOfficialHarnessAdapterRegistry,
  getOfficialHarnessDescriptor,
  listOfficialHarnessDescriptors,
  OFFICIAL_HARNESS_FAMILY_IDS,
  OfficialHarnessAdapterRegistry,
  resolveCanonicalOfficialHarnessId,
} from "./omnia-official-harness-adapters";

describe("official harness adapters", () => {
  it("ships all 9 official harness families with pinned provenance and conservative capability evidence", () => {
    const adapters = createBuiltInOfficialHarnessAdapters();
    expect(adapters).toHaveLength(9);
    expect(adapters.map((adapter) => adapter.descriptor().id)).toEqual([
      "openai-gpt-codex",
      "anthropic-claude-code",
      "google-gemini-agy",
      "custom-cache-first",
      "pi-code-cli",
      "opencode-cli",
      "hermes-self-improving",
      "strands-agent-graph",
      "oh-my-pi-openhands-kimi",
    ]);
    expect(OFFICIAL_HARNESS_FAMILY_IDS).toHaveLength(9);

    const codex = getOfficialHarnessDescriptor("openai-gpt-codex");
    const claude = getOfficialHarnessDescriptor("anthropic-claude-code");
    const openHandsKimi = getOfficialHarnessDescriptor("oh-my-pi-openhands-kimi");
    expect(codex.sources[0]?.revision).toBe("31ffe2bc9adccfe5fd3d29208250f796a13aa7a0");
    expect(claude.sources[0]?.tag).toBe("v2.1.272");
    expect(claude.capabilities.find((claim) => claim.capability === "event-journal")?.evidence).toBe("unverified");
    expect(openHandsKimi.sources).toHaveLength(2);
  });

  it("exposes architecture metadata, KV-cache strategy, and LTST memory integration across all 9 families", () => {
    const descriptors = listOfficialHarnessDescriptors();
    expect(descriptors).toHaveLength(9);
    for (const descriptor of descriptors) {
      expect(descriptor.displayName.length).toBeGreaterThan(5);
      expect(descriptor.familyLabel).toBeTruthy();
      expect(descriptor.architectureSummary).toBeTruthy();
      expect(descriptor.protocolFamily).toBeTruthy();
      expect(descriptor.kvCacheStrategy).toBeTruthy();
      expect(descriptor.memoryIntegrationMode).toBeTruthy();
      expect(descriptor.defaultModelId).toBeTruthy();
      expect(descriptor.targetThroughputTokPerSec).toBeGreaterThanOrEqual(100);
    }

    const customCacheFirst = getOfficialHarnessDescriptor("custom-cache-first");
    expect(customCacheFirst.targetThroughputTokPerSec).toBeGreaterThanOrEqual(150);
    expect(customCacheFirst.uriScheme).toBe("omnia");
  });

  it("normalizes known Codex lifecycle events deterministically across canonical and legacy IDs", () => {
    const registry = createOfficialHarnessAdapterRegistry();
    expect(
      registry.normalizeEvent("openai-gpt-codex", {
        type: "item/agentMessage/delta",
        id: "item-7",
        threadId: "thread-3",
        sequence: 4,
      }),
    ).toEqual({
      schemaVersion: 1,
      harnessId: "openai-gpt-codex",
      sourceEventName: "item/agentMessage/delta",
      canonicalEntity: "item",
      phase: "delta",
      sourceId: "item-7",
      parentSourceId: "thread-3",
      sequence: 4,
      evidence: "observed",
      known: true,
    });

    expect(
      registry.normalizeEvent("openai-codex", {
        type: "item/agentMessage/delta",
        id: "item-7",
        threadId: "thread-3",
        sequence: 4,
      }),
    ).toEqual({
      schemaVersion: 1,
      harnessId: "openai-codex",
      sourceEventName: "item/agentMessage/delta",
      canonicalEntity: "item",
      phase: "delta",
      sourceId: "item-7",
      parentSourceId: "thread-3",
      sequence: 4,
      evidence: "observed",
      known: true,
    });
  });

  it("keeps Claude mappings conservative instead of claiming private wire parity", () => {
    const registry = createOfficialHarnessAdapterRegistry();
    const message = registry.normalizeEvent("anthropic-claude-code", { type: "message.delta", id: "message-1" });
    const turn = registry.normalizeEvent("anthropic-claude-code", { type: "turn.complete", id: "turn-1" });
    expect(message).toMatchObject({ canonicalEntity: "item", phase: "delta", evidence: "inferred", known: true });
    expect(turn).toMatchObject({ canonicalEntity: "turn", phase: "completed", evidence: "documented", known: true });
  });

  it("normalizes events across Google AGY, Custom Cache-First, Pi-Code, OpenCode, Hermes, Strands, and Oh-My-Pi/OpenHands/Kimi", () => {
    const registry = createOfficialHarnessAdapterRegistry();

    expect(
      registry.normalizeEvent("google-gemini-agy", {
        type: "agy.subagent.invoked",
        id: "sub-1",
        conversationId: "conv-root",
      }),
    ).toMatchObject({
      harnessId: "google-gemini-agy",
      canonicalEntity: "session",
      phase: "started",
      sourceId: "sub-1",
      parentSourceId: "conv-root",
      known: true,
    });

    expect(
      registry.normalizeEvent("custom-cache-first", {
        type: "cache.prefix.locked",
        id: "prefix-99",
        sequence: 1,
      }),
    ).toMatchObject({
      harnessId: "custom-cache-first",
      canonicalEntity: "event",
      phase: "appended",
      sourceId: "prefix-99",
      sequence: 1,
      known: true,
    });

    expect(
      registry.normalizeEvent("pi-code-cli", {
        type: "pi.tool.execute",
        id: "tool-bash-1",
      }),
    ).toMatchObject({
      harnessId: "pi-code-cli",
      canonicalEntity: "tool",
      phase: "started",
      known: true,
    });

    expect(
      registry.normalizeEvent("opencode-cli", {
        type: "opencode.lsp.diagnostics",
        id: "diag-4",
      }),
    ).toMatchObject({
      harnessId: "opencode-cli",
      canonicalEntity: "observation",
      phase: "created",
      known: true,
    });

    expect(
      registry.normalizeEvent("hermes-self-improving", {
        type: "hermes.skill.distilled",
        id: "skill-kv-cache",
      }),
    ).toMatchObject({
      harnessId: "hermes-self-improving",
      canonicalEntity: "memory",
      phase: "created",
      known: true,
    });

    expect(
      registry.normalizeEvent("strands-agent-graph", {
        type: "strands.node.completed",
        nodeId: "dag-node-verify",
      }),
    ).toMatchObject({
      harnessId: "strands-agent-graph",
      canonicalEntity: "dag-node",
      phase: "completed",
      sourceId: "dag-node-verify",
      known: true,
    });

    expect(
      registry.normalizeEvent("oh-my-pi-openhands-kimi", {
        type: "condensation.created",
        id: "condense-1",
      }),
    ).toMatchObject({
      harnessId: "oh-my-pi-openhands-kimi",
      canonicalEntity: "conversation",
      phase: "compacted",
      known: true,
    });
  });

  it("fails closed for unknown events and strips URL/secret-like identifiers", () => {
    const registry = createOfficialHarnessAdapterRegistry();
    const unknown = registry.normalizeEvent("openhands", {
      type: "future.event",
      id: "https://example.test/raw",
      parentId: "sk-live-secret",
      sequence: "9",
    });
    expect(unknown).toEqual({
      schemaVersion: 1,
      harnessId: "openhands",
      sourceEventName: "future.event",
      canonicalEntity: "unknown",
      phase: "unknown",
      sequence: 9,
      evidence: "unverified",
      known: false,
    });
  });

  it("resolves canonical harness IDs and rejects duplicate registrations or unknown IDs", () => {
    expect(resolveCanonicalOfficialHarnessId("openai-codex")).toBe("openai-gpt-codex");
    expect(resolveCanonicalOfficialHarnessId("openhands")).toBe("oh-my-pi-openhands-kimi");
    expect(resolveCanonicalOfficialHarnessId("google-gemini-agy")).toBe("google-gemini-agy");
    expect(() => resolveCanonicalOfficialHarnessId("non-existent-harness")).toThrow(/Unknown official harness adapter/);

    const adapter = createBuiltInOfficialHarnessAdapters()[0];
    expect(adapter).toBeDefined();
    const registry = new OfficialHarnessAdapterRegistry();
    registry.register(adapter as NonNullable<typeof adapter>);
    expect(() => registry.register(adapter as NonNullable<typeof adapter>)).toThrow(/already registered/);
    expect(() => registry.resolve("openhands")).toThrow(/Unknown official harness adapter/);
  });

  it("computes real SHA-256, budgets cache_control breakpoints, and compiles the Super-Harness system block", async () => {
    const mod = await import("./omnia-official-harness-adapters");
    expect(mod.sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    // Verify tools -> system -> messages breakpoint hierarchy and pinned BP1 (tools) + BP2 (system)
    const shaped = mod.shapeAnthropicCacheControlBreakpoints({
      toolBreakpoints: ["1h"],
      systemBreakpoints: ["1h"],
      messageBreakpoints: ["5m", "5m", "5m", "5m"],
    });
    expect(shaped.hierarchyOrder).toEqual(["tools", "system", "messages"]);
    expect(shaped.strippedFromTools).toBe(0);
    expect(shaped.strippedFromSystem).toBe(0);
    expect(shaped.strippedFromMessages).toBe(2);
    expect(shaped.totalBreakpointsAfter).toBe(4);
    expect(shaped.ttlNormalizedOrder).toEqual(["1h", "1h", "5m", "5m"]);

    const superHarness = mod.compileOmniaSuperHarnessSystemPrompt({
      modelId: "claude-opus-4-6",
      effort: "max",
      enablePeerSubagentGroup: true,
    });
    expect(superHarness.systemBlocks).toHaveLength(1);
    expect(superHarness.systemBlocks[0].text).toContain("Omnia Universal Super-Harness");
    expect(superHarness.systemBlocks[0].text).not.toContain("billing-header");
    expect(superHarness.systemBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
