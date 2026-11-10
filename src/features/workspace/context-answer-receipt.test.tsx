import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildAnswerReceiptModel, ContextAnswerReceipt } from "./context-answer-receipt";
import type { CitationView } from "./evidence-types";

const citation: CitationView = {
  id: "citation-answer-1",
  messageId: "answer-1",
  runId: "run-1",
  sourceId: "source-1",
  snapshotId: "snapshot-1",
  displayIndex: 1,
  title: "Project source",
  sourceType: "workspace",
  locatorLabel: "README.md · line 4",
  uri: null,
  excerpt: "A retained source excerpt.",
  retrievedAt: "2026-09-24T00:00:00.000Z",
  sourceContentHash: "a".repeat(64),
  sourceStart: 0,
  sourceEnd: 24,
  sourceAvailableInSnapshot: true,
  answerStart: 0,
  answerEnd: 12,
  verificationState: "verified",
};

const unrelated: CitationView = {
  ...citation,
  id: "citation-other",
  messageId: "answer-other",
  runId: "run-other",
  displayIndex: 2,
  title: "Other answer source",
};

describe("ContextAnswerReceipt", () => {
  it("scopes rows to the current answer and run", () => {
    const model = buildAnswerReceiptModel({ citations: [citation, unrelated], messageId: "answer-1", runId: "run-1" });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.title).toBe("Project source");
    expect(model.verifiedCount).toBe(1);
    expect(model.scopeLabel).toContain("run run-1");
  });

  it("downgrades invalid verified evidence and keeps the boundary explicit", () => {
    const model = buildAnswerReceiptModel({
      citations: [{ ...citation, sourceContentHash: null, sourceAvailableInSnapshot: false }],
      messageId: "answer-1",
      runId: "run-1",
    });

    expect(model.rows[0]?.state).toBe("review");
    expect(model.reviewCount).toBe(1);
    expect(model.boundary).toMatch(/does not infer sources/i);
  });

  it("renders an honest empty state when no answer is selected", () => {
    render(<ContextAnswerReceipt citations={[citation]} messageId={null} runId={null} />);

    expect(screen.getByTestId("answer-evidence-receipt")).toHaveTextContent(/No harness-persisted citation evidence/i);
    expect(screen.getByText(/Missing evidence is not proof/i)).toBeInTheDocument();
  });
});
