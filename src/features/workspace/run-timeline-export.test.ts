import { describe, expect, it } from "vitest";

import {
  RUN_TIMELINE_EXPORT_FORMAT,
  describeRunTimelineCoverage,
  serializeRunTimelineExport,
} from "./run-timeline-export";
import type { RunTimelineEventView } from "./evidence-types";

const runId = "run_0123456789abcdef0123456789abcdef";

const events: RunTimelineEventView[] = [
  {
    id: "run_event_1",
    runId,
    parentEventId: null,
    sequence: 1,
    type: "run.started",
    stage: "provider",
    status: "running",
    summary: "Provider stream started",
    detail: "Model: model-x",
    startedAt: "2026-09-19T00:00:00.000Z",
    endedAt: null,
    source: "provider",
    providerLabel: "model-x",
    attemptOrdinal: 1,
    citationIds: [],
  },
  {
    id: "run_event_2",
    runId,
    parentEventId: null,
    sequence: 2,
    type: "run.completed",
    stage: "finalization",
    status: "complete",
    summary: "Run completed",
    detail: "Finish: stop",
    startedAt: "2026-09-19T00:00:01.000Z",
    endedAt: "2026-09-19T00:00:01.100Z",
    source: "harness",
    providerLabel: null,
    attemptOrdinal: null,
    citationIds: [],
  },
];

describe("run timeline export preview", () => {
  it("describes advisory and unknown coverage without promoting it to complete", () => {
    expect(describeRunTimelineCoverage("legacy-partial", "Live notification only")).toEqual({
      label: "Legacy partial replay",
      detail: "Live notification only",
      tone: "warning",
    });
    expect(describeRunTimelineCoverage("unknown")).toMatchObject({
      label: "Coverage unknown",
      tone: "unknown",
    });
  });

  it("redacts diagnostic-looking coverage reasons before showing them", () => {
    const description = describeRunTimelineCoverage(
      "legacy-partial",
      "authorization=Bearer sk-live-secret C:\\Users\\khang\\private.txt",
    );
    expect(description.detail).toContain("authorization=[REDACTED]");
    expect(description.detail).toContain("[REDACTED_PATH]");
    expect(description.detail).not.toContain("sk-live-secret");
    expect(description.detail).not.toContain("C:\\Users\\khang\\private.txt");
  });

  it("downgrades a complete receipt when the visible sequence has integrity issues", () => {
    expect(describeRunTimelineCoverage("complete", null, 1)).toEqual({
      label: "Complete receipt · integrity review",
      detail: "Coverage reports complete, but the visible sequence has integrity issues. Review this read-only projection before relying on it.",
      tone: "warning",
    });
  });

  it("serializes a bounded JSON package with explicit renderer boundaries", () => {
    const payload = serializeRunTimelineExport({
      runId,
      events,
      coverage: "complete",
      format: "json",
      generatedAt: "2026-09-19T00:00:02.000Z",
    });
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    expect(parsed.format).toBe(RUN_TIMELINE_EXPORT_FORMAT);
    expect(parsed.scope).toBe("renderer-session");
    expect(parsed.runId).toBe(runId);
    expect(parsed.eventCount).toBe(2);
    expect(parsed.coverage).toBe("complete");
    expect(JSON.stringify(parsed)).toContain("native export receipt");
    expect(JSON.stringify(parsed)).toContain("hidden provider payloads");
    expect((parsed.events as Array<Record<string, unknown>>)[1]?.summary).toBe("Run completed");
  });

  it("preserves integrity issues and redacts sensitive-looking text in Markdown", () => {
    const payload = serializeRunTimelineExport({
      runId,
      events: [{ ...events[0]!, detail: "authorization=Bearer sk-super-secret-token" }],
      issues: ["Missing event sequences 2–3.", "C:\\Users\\khang\\secret.txt"],
      format: "markdown",
      generatedAt: "2026-09-19T00:00:02.000Z",
    });

    expect(payload).toContain("# Omnia run timeline preview");
    expect(payload).toContain("Coverage: Partial");
    expect(payload).toContain("Missing event sequences");
    expect(payload).toContain("authorization=[REDACTED]");
    expect(payload).toContain("[REDACTED_PATH]");
    expect(payload).not.toContain("sk-super-secret-token");
    expect(payload).not.toContain("C:\\Users\\khang\\secret.txt");
  });
});
