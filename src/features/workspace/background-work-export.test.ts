import { describe, expect, it } from "vitest";

import { projectBackgroundWork } from "./background-work-projection";
import type { BackgroundWorkProjection } from "./background-work-projection";
import {
  BACKGROUND_WORK_EXPORT_FORMAT,
  serializeBackgroundWorkExport,
} from "./background-work-export";

describe("background-work export preview", () => {
  it("serializes canonical counts and redacts sensitive-looking item text", () => {
    const projection = projectBackgroundWork({
      generatedAt: "2026-09-19T05:00:00.000Z",
      conversations: [
        {
          id: "conversation-export",
          activeBranchId: "branch-export",
          title: "Export bearer sk-export-secret-token",
          excerpt: "Read C:\\Users\\khang\\private\\notes.md",
          updatedAt: "2026-09-19T04:59:00.000Z",
          updatedLabel: "now",
          projectId: null,
          projectName: null,
          pinned: false,
          archived: false,
          hasDraft: false,
          unread: false,
          runState: "streaming",
          draft: "",
          messages: [],
        },
      ],
    });

    const payload = serializeBackgroundWorkExport({
      projection,
      format: "json",
      generatedAt: "2026-09-19T05:00:01.000Z",
    });
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    expect(parsed.format).toBe(BACKGROUND_WORK_EXPORT_FORMAT);
    expect(parsed.scope).toBe("renderer-session");
    expect(JSON.stringify(parsed)).toContain("does not create a durable queue");
    expect(JSON.stringify(parsed)).not.toContain("sk-export-secret-token");
    expect(JSON.stringify(parsed)).not.toContain("C:\\Users\\khang\\private\\notes.md");
    expect((parsed.projection as { counts: { total: number; active: number } }).counts).toMatchObject({
      total: 1,
      active: 1,
    });
  });

  it("renders a readable Markdown summary with capabilities and item details", () => {
    const projection = projectBackgroundWork({
      generatedAt: "2026-09-19T05:00:00.000Z",
      conversations: [],
    });

    const payload = serializeBackgroundWorkExport({ projection, format: "markdown" });

    expect(payload).toContain("# Omnia background work preview");
    expect(payload).toContain("## Missing capabilities");
    expect(payload).toContain("durable task/goal queue");
    expect(payload).toContain("## Items");
    expect(payload).toContain("No background-work items are visible");
  });

  it("escapes Markdown table characters and keeps nullable identifiers explicit", () => {
    const projection: BackgroundWorkProjection = {
      schemaVersion: 1,
      generatedAt: "2026-09-19T05:00:00.000Z",
      counts: { total: 1, active: 0, queued: 0, waiting: 0, attention: 1, completed: 0 },
      boundary: "Renderer-safe background-work projection.",
      missingCapabilities: [],
      items: [{
        id: "run:markdown-item",
        kind: "run-timeline",
        state: "attention",
        title: "Provider | warning\nwith newline",
        subtitle: "Outcome | unknown",
        detail: null,
        conversationId: null,
        runId: null,
        updatedAt: "2026-09-19T05:00:00.000Z",
        durability: "native-projection",
        attention: true,
        actions: ["inspect"],
      }],
    };

    const payload = serializeBackgroundWorkExport({
      projection,
      format: "markdown",
      generatedAt: "2026-09-19T05:00:01.000Z",
    });

    expect(payload).toContain("### Provider \\| warning with newline");
    expect(payload).toContain("- Subtitle: Outcome \\| unknown");
    expect(payload).toContain("- Detail: Not retained");
    expect(payload).toContain("- Run: Not retained");
    expect(payload).toContain("- Conversation: Not retained");
  });
});
