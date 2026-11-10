import { describe, expect, it } from "vitest";

import { compareComposerDraftVersions, summarizeComposerDraftVersion } from "./composer-draft-versions";

describe("composer draft version comparison", () => {
  it("aligns inserted lines and reports a bounded renderer-local diff", () => {
    const result = compareComposerDraftVersions("Heading\nLast line", "Heading\nNew line\nLast line");
    expect(result).toMatchObject({ changed: true, addedLines: 1, removedLines: 0, characterDelta: 9, tooLarge: false });
    expect(result.preview).toEqual([
      { kind: "same", lineNumber: 1, text: "Heading" },
      { kind: "added", lineNumber: 2, text: "New line" },
      { kind: "same", lineNumber: 3, text: "Last line" },
    ]);
  });

  it("bounds preview output and avoids quadratic work for oversized line sets", () => {
    const bounded = compareComposerDraftVersions("a\nb\nc\nd", "a\nb\nc\nd", 2);
    expect(bounded.preview).toHaveLength(2);
    expect(bounded.truncated).toBe(true);

    const tooLarge = compareComposerDraftVersions("a\n".repeat(301), "b\n".repeat(301));
    expect(tooLarge.tooLarge).toBe(true);
    expect(tooLarge.preview).toEqual([]);
    expect(tooLarge.changed).toBe(true);
  });

  it("summarizes basic draft size without treating estimates as provider telemetry", () => {
    expect(summarizeComposerDraftVersion("one two\nthree")).toEqual({ characters: 13, lines: 2, words: 3 });
    expect(summarizeComposerDraftVersion("")).toEqual({ characters: 0, lines: 0, words: 0 });
  });
});
