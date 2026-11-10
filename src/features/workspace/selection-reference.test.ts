import { describe, expect, it } from "vitest";

import {
  createSelectionReferenceDraft,
  createTextSelectionAnchor,
  formatSelectionReferencePreview,
  isUsableSelectionAnchor,
  reanchorTextSelection,
  stableTextHash,
} from "./selection-reference";

function anchor(overrides: Partial<Parameters<typeof createTextSelectionAnchor>[0]> = {}) {
  return createTextSelectionAnchor({
    selectionId: "selection_message_1",
    sourceKind: "assistant-message",
    sourceId: "message_1",
    sourceRevisionId: "revision_1",
    sourceText: "A stable answer explains the invariant before showing the implementation.",
    startOffset: 2,
    endOffset: 24,
    ...overrides,
  });
}

describe("selection reference projection", () => {
  it("creates an exact, revision-bound anchor with surrounding provenance", () => {
    const result = anchor();

    expect(result.exactText).toBe("stable answer explains");
    expect(result.startOffset).toBe(2);
    expect(result.endOffset).toBe(24);
    expect(result.sourceRevisionId).toBe("revision_1");
    expect(result.surroundingText).toContain(result.exactText);
    expect(result.surroundingHash).toBe(stableTextHash(result.surroundingText));
    expect(result.semanticFingerprint).toBe(stableTextHash(result.exactText.toLocaleLowerCase()));
    expect(result.stale).toBe(false);
    expect(isUsableSelectionAnchor(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects an empty or out-of-bounds range before creating a reference", () => {
    expect(() => anchor({ startOffset: 0, endOffset: 0 })).toThrow(/range/i);
    expect(() => anchor({ startOffset: 0, endOffset: 500 })).toThrow(/exceeds/i);
  });

  it("reanchors a unique exact match after a source revision", () => {
    const original = anchor();
    const result = reanchorTextSelection(
      original,
      "A revised answer now says: stable answer explains the invariant before showing the implementation.",
      "revision_2",
    );

    expect(result.stale).toBe(false);
    expect(result.sourceRevisionId).toBe("revision_2");
    expect(result.exactText).toBe(original.exactText);
    expect(result.startOffset).toBe(27);
    expect(result.endOffset).toBe(49);
    expect(isUsableSelectionAnchor(result)).toBe(true);
  });

  it("marks missing or changed text stale instead of guessing a nearby sentence", () => {
    const original = anchor();

    const missing = reanchorTextSelection(original, null, "revision_2");
    expect(missing.stale).toBe(true);
    expect(missing.staleReason).toBe("missing-source");
    expect(isUsableSelectionAnchor(missing)).toBe(false);

    const changed = reanchorTextSelection(original, "A completely different answer.", "revision_3");
    expect(changed.stale).toBe(true);
    expect(changed.staleReason).toBe("source-changed");
  });

  it("marks duplicate exact matches stale when context cannot disambiguate", () => {
    const original = createTextSelectionAnchor({
      selectionId: "selection_duplicate",
      sourceKind: "assistant-message",
      sourceId: "message_duplicate",
      sourceRevisionId: "revision_1",
      sourceText: "prefix stable answer suffix and stable answer suffix",
      startOffset: 7,
      endOffset: 20,
    });

    const result = reanchorTextSelection(
      original,
      "new stable answer and another stable answer",
      "revision_2",
    );

    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe("ambiguous-reanchor");
  });

  it("creates a draft-only quote reference and a readable preview", () => {
    const reference = createSelectionReferenceDraft({
      anchor: anchor(),
      mode: "reply",
      sourceLabel: "Omnia answer · message_1",
      authorLabel: "Omnia",
      intent: "Explain the invariant",
      createdAt: "2026-09-09T00:00:00.000Z",
    });

    expect(reference.id).toMatch(/^reference_/);
    expect(reference.mode).toBe("reply");
    expect(formatSelectionReferencePreview(reference)).toBe(
      "> stable answer explains\n\n— Omnia answer · message_1 · Omnia",
    );
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("does not allow stale anchors into a composer reference draft", () => {
    const stale = reanchorTextSelection(anchor(), "No matching content", "revision_9");

    expect(() =>
      createSelectionReferenceDraft({
        anchor: stale,
        mode: "context",
        sourceLabel: "Stale answer",
      }),
    ).toThrow(/stale|empty/i);
  });
});
