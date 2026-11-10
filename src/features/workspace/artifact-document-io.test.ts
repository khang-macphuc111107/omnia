import { describe, expect, it } from "vitest";

import {
  importArtifactDocument,
  serializeArtifactDocumentBundle,
  serializeArtifactDocumentMarkdown,
} from "./artifact-document-io";

const input = {
  artifactName: "research-notes.md",
  projectName: "Omnia Desktop",
  revision: 2,
  content: "# Research notes\n\nA renderer-local draft.",
  exportedAt: "2026-09-19T00:00:00.000Z",
};

describe("artifact document portable I/O", () => {
  it("round-trips a strict JSON bundle", () => {
    const result = importArtifactDocument(serializeArtifactDocumentBundle(input));
    expect(result).toEqual({
      ok: true,
      source: "json",
      bundle: {
        scope: "omnia-artifact-document-preview",
        version: 1,
        exportedAt: input.exportedAt,
        artifactName: input.artifactName,
        projectName: input.projectName,
        revision: input.revision,
        content: input.content,
      },
    });
  });

  it("round-trips portable Markdown and accepts plain Markdown with neutral metadata", () => {
    const portable = importArtifactDocument(serializeArtifactDocumentMarkdown(input));
    expect(portable.ok).toBe(true);
    if (portable.ok) {
      expect(portable.source).toBe("markdown");
      expect(portable.bundle.content).toBe(input.content);
      expect(portable.bundle.revision).toBe(2);
    }

    const plain = importArtifactDocument("# Imported title\n\nPlain content");
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.source).toBe("plain-markdown");
      expect(plain.bundle.artifactName).toBe("Imported title");
      expect(plain.bundle.projectName).toBe("Imported preview");
    }
  });

  it("fails closed for invalid scope, malformed JSON, and oversized input", () => {
    const invalid = importArtifactDocument(JSON.stringify({ ...input, scope: "other" }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.join(" ")).toMatch(/scope/i);

    const malformed = importArtifactDocument("{not-json");
    expect(malformed.ok).toBe(false);

    const oversized = importArtifactDocument("x".repeat(2_000_001));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.errors.join(" ")).toMatch(/2 MB/i);
  });
});
