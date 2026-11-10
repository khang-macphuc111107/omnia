import { describe, expect, it } from "vitest";
import {
  ACADEMIC_CITATION_BUNDLE_SCOPE,
  importAcademicCitationBundle,
  serializeAcademicCitationBundle,
  serializeAcademicCitationMarkdown,
} from "./academic-citation-bundle";

const citations = [
  { id: "c1", label: "[1] Source one", status: "placeholder" as const, text: "Author, A. (2026). Source one." },
  { id: "c2", label: "[2] Source two", status: "needs review" as const, text: "Author, B. (2026). Source two." },
];

describe("academic citation bundle", () => {
  it("round-trips the strict JSON bundle and preserves citation metadata", () => {
    const raw = serializeAcademicCitationBundle({ title: "Evidence report", citationStyle: "IEEE", citations });
    const result = importAcademicCitationBundle(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("json");
    expect(result.bundle.scope).toBe(ACADEMIC_CITATION_BUNDLE_SCOPE);
    expect(result.bundle.title).toBe("Evidence report");
    expect(result.bundle.citations).toEqual(citations);
  });

  it("round-trips portable Markdown without fetching or verifying sources", () => {
    const raw = serializeAcademicCitationMarkdown({ title: "Markdown report", citationStyle: "APA 7", citations });
    const result = importAcademicCitationBundle(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("markdown");
    expect(result.bundle.citationStyle).toBe("APA 7");
    expect(result.bundle.citations[1]?.status).toBe("needs review");
  });

  it("supports a simple Markdown list as a neutral renderer-local import", () => {
    const result = importAcademicCitationBundle("- First paper\n- Second paper");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("plain-markdown");
    expect(result.bundle.citations).toHaveLength(2);
    expect(result.bundle.citations[0]?.text).toBe("First paper");
  });

  it("fails closed for invalid status and oversized citation text", () => {
    const raw = JSON.stringify({
      scope: ACADEMIC_CITATION_BUNDLE_SCOPE,
      version: 1,
      exportedAt: new Date().toISOString(),
      title: "Invalid",
      citationStyle: "IEEE",
      citations: [{ id: "bad", label: "Bad", status: "verified", text: "x".repeat(4_001) }],
    });
    const result = importAcademicCitationBundle(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/status is not supported/i);
    expect(result.errors.join(" ")).toMatch(/too long/i);
  });
});
