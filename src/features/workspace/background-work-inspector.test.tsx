import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RunTimelineEventView } from "./evidence-types";
import {
  BackgroundWorkInspector,
  backgroundWorkRowsFromProjection,
  buildBackgroundWorkTaskFacets,
  buildBackgroundWorkTaskMilestones,
  buildBackgroundWorkRows,
  type BackgroundWorkProjectionInput,
} from "./background-work-inspector";
import { projectBackgroundWork } from "./background-work-projection";
import type { BackgroundWorkProjection } from "./background-work-projection";
import type { ConversationView } from "./types";

const conversation = {
  id: "conversation-background",
  activeBranchId: "branch-background",
  title: "Background architecture pass",
  excerpt: "Compare the provider harness boundaries.",
  updatedAt: "2026-09-19T01:00:00.000Z",
  updatedLabel: "Now",
  projectId: "project-omnia",
  projectName: "Omnia Desktop",
  pinned: false,
  archived: false,
  hasDraft: false,
  unread: false,
  runState: "streaming",
  draft: "",
  messages: [
    {
      id: "message-background",
      role: "assistant",
      content: "Working through the background inspector.",
      createdAt: "2026-09-19T01:00:00.000Z",
      status: "streaming",
      modelLabel: "Auto",
      runId: "run-background",
      attachments: [],
      branchIndex: 1,
      branchCount: 1,
    },
  ],
} satisfies ConversationView;

const event: RunTimelineEventView = {
  id: "run-event-background",
  runId: "run-background-done",
  parentEventId: null,
  sequence: 2,
  type: "run.completed",
  stage: "finalization",
  status: "complete",
  summary: "Run completed",
  detail: "Finish: stop",
  startedAt: "2026-09-19T00:00:00.000Z",
  endedAt: "2026-09-19T00:01:00.000Z",
  source: "harness",
  providerLabel: "preview-model",
  attemptOrdinal: null,
  citationIds: [],
};

const projection: BackgroundWorkProjectionInput = {
  conversations: [conversation],
  activeRun: {
    id: "run-background",
    conversationId: conversation.id,
    assistantMessageId: "message-background",
    stage: "writing",
    startedAt: "2026-09-19T01:00:00.000Z",
  },
  timelineEvents: [event],
};

describe("background work inspector", () => {
  it("projects active conversations and completed timeline runs once each", () => {
    const rows = buildBackgroundWorkRows(projection);
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["run-background", "working"],
      ["run-background-done", "completed"],
    ]);
    expect(rows.find((row) => row.id === "run-background")?.eventCount).toBeUndefined();
    expect(rows.find((row) => row.id === "run-background-done")?.eventCount).toBe(1);
  });

  it("adapts the canonical projection without losing attention semantics", () => {
    const canonical = projectBackgroundWork({
      conversations: [{ ...conversation, runState: "failed" }],
      generatedAt: "2026-09-19T01:02:00.000Z",
    });
    const rows = backgroundWorkRowsFromProjection(canonical);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `conversation:${conversation.id}`,
      kind: "run",
      state: "failed",
      name: conversation.title,
    });
  });

  it("keeps checkpoint evidence distinct from goal rows", () => {
    const canonical: BackgroundWorkProjection = {
      schemaVersion: 1,
      items: [{
        id: "checkpoint:checkpoint-preview",
        kind: "checkpoint",
        state: "waiting",
        title: "Run checkpoint",
        subtitle: "Paused",
        detail: "Checkpoint is available for inspection.",
        conversationId: null,
        runId: "run-preview",
        updatedAt: "2026-09-19T01:02:00.000Z",
        durability: "native-projection",
        attention: false,
        actions: ["inspect"],
      }],
      counts: { total: 1, active: 0, queued: 0, waiting: 1, attention: 0, completed: 0 },
      generatedAt: "2026-09-19T01:02:00.000Z",
      boundary: "Renderer-safe background-work projection.",
      missingCapabilities: [],
    };

    expect(backgroundWorkRowsFromProjection(canonical)[0]).toMatchObject({
      kind: "checkpoint",
      name: "Run checkpoint",
      state: "waiting",
    });
  });

  it("projects a replayed running event and avoids a duplicate when the Chat already owns that run ID", () => {
    const runningRunId = "run-background-running";
    const replayedConversation = {
      ...conversation,
      runState: null,
      messages: [
        {
          ...conversation.messages[0]!,
          runId: runningRunId,
        },
      ],
    } satisfies ConversationView;
    const rows = buildBackgroundWorkRows({
      conversations: [replayedConversation],
      activeRun: null,
      timelineEvents: [
        {
          ...event,
          id: "run-event-background-running",
          runId: runningRunId,
          sequence: 1,
          type: "run.started",
          status: "running",
          summary: "Provider stream started",
          endedAt: null,
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: runningRunId,
      state: "working",
      name: conversation.title,
      eventCount: 1,
    });
  });

  it("keeps role and runtime state separate and exposes truthful controls", () => {
    const onOpenThread = vi.fn();
    const onPeek = vi.fn();
    const rows = buildBackgroundWorkRows(projection);
    render(<BackgroundWorkInspector rows={rows} onOpenThread={onOpenThread} onPeek={onPeek} />);

    expect(screen.getByRole("heading", { name: "Background work" })).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText(/Renderer projection only/)).toBeInTheDocument();

    const rowsRegion = screen.getByRole("list", { name: /2 background work items/i });
    fireEvent.click(within(rowsRegion).getByRole("listitem", { name: /preview-model run/i }));
    expect(onPeek).toHaveBeenCalledWith(expect.objectContaining({ id: "run-background-done" }));
    expect(screen.getByRole("heading", { name: "preview-model run" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "run-background-done" }));
    expect(screen.getByRole("button", { name: /Stop unavailable/i })).toBeDisabled();
  });

  it("filters attention and done rows without mutating the projection", () => {
    const rows = buildBackgroundWorkRows({ ...projection, conversations: [{ ...conversation, runState: "failed" }] });
    render(<BackgroundWorkInspector rows={rows} />);

    const filters = screen.getByRole("navigation", { name: "Background work filters" });
    fireEvent.click(within(filters).getByRole("button", { name: /Done/i }));
    expect(screen.getByRole("list", { name: /1 background work item/i })).toHaveTextContent("preview-model run");
    fireEvent.click(within(filters).getByRole("button", { name: /Attention/i }));
    expect(screen.getByRole("list", { name: /1 background work item/i })).toHaveTextContent("Background architecture pass");
  });

  it("searches the visible queue and supports roving row navigation", () => {
    const rows = buildBackgroundWorkRows(projection);
    render(<BackgroundWorkInspector rows={rows} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search background work" }), { target: { value: "preview-model" } });
    const filteredList = screen.getByRole("list", { name: /1 background work item matching preview-model/i });
    expect(filteredList).toHaveTextContent("preview-model run");
    expect(filteredList).not.toHaveTextContent("Background architecture pass");

    fireEvent.click(screen.getByRole("listitem", { name: /preview-model run/i }));
    const row = screen.getByRole("listitem", { name: /preview-model run/i });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search background work" }), { target: { value: "" } });
    const activeRow = screen.getByRole("listitem", { name: /preview-model run/i });
    activeRow.focus();
    fireEvent.keyDown(activeRow, { key: "ArrowUp" });
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringMatching(/Background architecture pass/));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toHaveAttribute("aria-label", expect.stringMatching(/preview-model run/));
    expect(row).toBeInTheDocument();
  });

  it("exposes a truthful task-inspector lens for goal, agent, queue, approval, and checkpoint gaps", () => {
    const rows = buildBackgroundWorkRows(projection);
    const facets = buildBackgroundWorkTaskFacets(rows[0]!);
    expect(facets).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "goal", state: "unknown" }),
      expect.objectContaining({ key: "phase", state: "preview", value: "Writing" }),
      expect.objectContaining({ key: "agent", state: "planned" }),
      expect.objectContaining({ key: "queue", state: "unknown" }),
      expect.objectContaining({ key: "checkpoint", state: "unknown" }),
    ]));

    render(<BackgroundWorkInspector rows={rows} />);
    fireEvent.click(screen.getByRole("tab", { name: "Task inspector" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Agent identity not hydrated");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Checkpoint not reported");
    expect(screen.getAllByText("Planned").length).toBeGreaterThan(0);
  });

  it("keeps projected timeline milestones separate from durable checkpoint claims", () => {
    const rows = buildBackgroundWorkRows(projection);
    const milestones = buildBackgroundWorkTaskMilestones(rows[1]!);
    expect(milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Current state", value: "Completed", state: "preview" }),
      expect.objectContaining({ label: "Projected event count", value: "1", state: "preview" }),
    ]));

    render(<BackgroundWorkInspector rows={rows} />);
    fireEvent.click(within(screen.getByRole("list", { name: /2 background work items/i })).getByRole("listitem", { name: /preview-model run/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Projected event count");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("1");
  });
});
