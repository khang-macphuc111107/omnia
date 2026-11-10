import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type { ContextItemId, ContextSnapshotId } from "./ids";
import { compileContext, type ContextItem } from "./context";

const now = "2026-08-13T00:00:00.000Z";
const hash = (character: string) => character.repeat(64);
const itemId = (value: string) => value as ContextItemId;

function contextItem(
  id: string,
  overrides: Partial<ContextItem> = {},
): ContextItem {
  return {
    id: itemId(id),
    kind: "workspace_chunk",
    contentRef: `blob:${id}`,
    contentHash: hash("a"),
    sourceRef: `workspace:${id}`,
    authority: "untrusted_data",
    semanticRole: "evidence",
    survivalPolicy: "evictable",
    scope: "project",
    sensitivity: [],
    tokenEstimate: 10,
    relevance: 0.5,
    priority: 1,
    pinned: false,
    required: false,
    summarizable: true,
    cacheClass: "dynamic",
    dependencyItemIds: [],
    ...overrides,
  };
}

function compile(
  candidates: readonly ContextItem[],
  overrides: Record<string, unknown> = {},
) {
  return compileContext({
    snapshotId: "context-c0-snapshot" as ContextSnapshotId,
    candidates,
    modelContextLimit: 1_000,
    reservedOutputTokens: 100,
    providerOverheadTokens: 10,
    toolSchemaTokens: 0,
    safetyMarginTokens: 10,
    now,
    tokenizer: "test-tokenizer-v1",
    estimatorUncertain: false,
    ...overrides,
  });
}

describe("context C0 authority and dependency contract", () => {
  it("rejects assistant, summary, memory, and skill-resource authority promotion", () => {
    const promoted: readonly ContextItem[] = [
      contextItem("assistant", {
        kind: "assistant_message",
        authority: "user_instruction",
        semanticRole: "conversation_assistant",
      }),
      contextItem("summary", {
        kind: "conversation_summary",
        authority: "user_instruction",
        semanticRole: "state_capsule",
        survivalPolicy: "structured_digest_only",
      }),
      contextItem("memory", {
        kind: "memory",
        authority: "platform_invariant",
        semanticRole: "memory_background",
        survivalPolicy: "structured_digest_only",
      }),
      contextItem("skill-resource", {
        kind: "skill_resource",
        authority: "workflow_guidance",
        semanticRole: "evidence",
      }),
    ];

    for (const candidate of promoted) {
      expect(() => compile([candidate])).toThrowError(
        expect.objectContaining<Partial<DomainError>>({
          code: "scope_violation",
        }),
      );
    }
  });

  it("records candidate, selection, semantic, and adapter order independently", () => {
    const instruction = contextItem("instruction", {
      kind: "product_instruction",
      authority: "platform_invariant",
      semanticRole: "instruction",
      survivalPolicy: "verbatim_always",
      required: true,
      pinned: true,
      summarizable: false,
      priority: 100,
    });
    const evidence = contextItem("evidence", { relevance: 1, priority: 10 });
    const current = contextItem("current", {
      kind: "user_message",
      authority: "user_instruction",
      semanticRole: "conversation_user",
      survivalPolicy: "verbatim_always",
      scope: "conversation",
      required: true,
      pinned: true,
      summarizable: false,
      priority: 1_000,
    });

    const snapshot = compile([evidence, current, instruction], {
      semanticOrderItemIds: [instruction.id, evidence.id, current.id],
      adapterOrderItemIds: [instruction.id, evidence.id, current.id],
    });

    expect(snapshot.candidateItemIds).toEqual([
      evidence.id,
      current.id,
      instruction.id,
    ]);
    expect(snapshot.selectedItemIds).toEqual([
      instruction.id,
      current.id,
      evidence.id,
    ]);
    expect(snapshot.semanticItemIds).toEqual([
      instruction.id,
      evidence.id,
      current.id,
    ]);
    expect(snapshot.adapterItemIds).toEqual(snapshot.semanticItemIds);
    expect(
      snapshot.candidates.find((decision) => decision.item.id === evidence.id),
    ).toEqual(
      expect.objectContaining({
        selectionOrder: 2,
        semanticOrder: 1,
        adapterOrder: 1,
        serializedOrder: 1,
      }),
    );
  });

  it("rejects unknown, duplicate, or incomplete order projections", () => {
    const left = contextItem("left");
    const right = contextItem("right");

    expect(() =>
      compile([left, right], { semanticOrderItemIds: [left.id] }),
    ).toThrowError(expect.objectContaining({ code: "invalid_argument" }));
    expect(() =>
      compile([left, right], { semanticOrderItemIds: [left.id, left.id] }),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() =>
      compile([left, right], {
        adapterOrderItemIds: [left.id, itemId("unknown")],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_argument" }));
  });

  it("fails closed for missing dependencies and cycles", () => {
    const missing = contextItem("missing", {
      dependencyItemIds: [itemId("absent")],
    });
    expect(() => compile([missing])).toThrowError(
      expect.objectContaining({ code: "invalid_argument" }),
    );

    const left = contextItem("left", { dependencyItemIds: [itemId("right")] });
    const right = contextItem("right", { dependencyItemIds: [itemId("left")] });
    expect(() => compile([left, right])).toThrowError(
      expect.objectContaining({ code: "conflict" }),
    );
  });
});
