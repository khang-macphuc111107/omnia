import { describe, expect, it } from "vitest";

import {
  assessComposerPaste,
  composerPasteReasonLabels,
  composerPastePreviewExcerpt,
  formatComposerPasteMetrics,
  formatComposerPasteNotice,
  insertTextAtSelection,
  projectComposerPasteFile,
} from "./composer-paste";

describe("composer paste assessment", () => {
  it("keeps a small plain-text paste inline without a conversion notice", () => {
    const assessment = assessComposerPaste("Hello, Omnia!");

    expect(assessment.recommendedDisposition).toBe("inline");
    expect(assessment.fallbackDisposition).toBe("inline");
    expect(formatComposerPasteNotice(assessment)).toBe("");
  });

  it("reports every crossed threshold and preserves rich clipboard evidence", () => {
    const assessment = assessComposerPaste(
      "a\n".repeat(5),
      "<p>a</p>",
      {
        thresholds: {
          maxCharacters: 3,
          maxEstimatedTokens: 2,
          maxBytes: 3,
          maxLines: 2,
        },
      },
    );

    expect(assessment.recommendedDisposition).toBe("convert_to_file");
    expect(assessment.fallbackDisposition).toBe("inline_with_warning");
    expect(composerPasteReasonLabels(assessment)).toEqual([
      "character limit",
      "estimated-token limit",
      "UTF-8 byte limit",
      "line limit",
    ]);
    expect(formatComposerPasteMetrics(assessment)).toMatch(
      /10 characters · 10 bytes · 6 lines · ~\d+ tokens/,
    );
    expect(formatComposerPasteNotice(assessment)).toMatch(
      /Native paste-to-file conversion is not available.*Rich clipboard formatting was detected/i,
    );
  });

  it("inserts text at the selection and returns the new cursor position", () => {
    expect(insertTextAtSelection("before after", "middle ", 7, 12)).toEqual({
      value: "before middle ",
      cursor: 14,
    });
  });

  it("clamps invalid selection offsets instead of producing malformed text", () => {
    expect(insertTextAtSelection("abc", "X", -2, 99)).toEqual({
      value: "X",
      cursor: 1,
    });
  });

  it("projects a threshold crossing into a truthful file-like preview", () => {
    const assessment = assessComposerPaste("# Build notes\n\n" + "x".repeat(40_000), "<h1>Build notes</h1>");
    const projection = projectComposerPasteFile(assessment);

    expect(projection.suggestedName).toBe("build-notes.txt");
    expect(projection.mediaType).toBe("text/plain");
    expect(projection.extension).toBe("txt");
    expect(projection.previewHash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
    expect(projection.richClipboardDetected).toBe(true);
    expect(projection.sourceText).toBe(assessment.sourceText);
  });

  it("caps the visible preview excerpt without changing the source text", () => {
    expect(composerPastePreviewExcerpt("abcdef", 4)).toBe("abc…");
    expect(composerPastePreviewExcerpt("short", 20)).toBe("short");
  });
});
