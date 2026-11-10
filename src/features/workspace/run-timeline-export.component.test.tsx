import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunTimeline } from "./citation-timeline";
import type { RunTimelineEventView } from "./evidence-types";

const runId = "run_0123456789abcdef0123456789abcdef";

const event: RunTimelineEventView = {
  id: "run_event_1",
  runId,
  parentEventId: null,
  sequence: 1,
  type: "run.completed",
  stage: "finalization",
  status: "complete",
  summary: "Run completed",
  detail: "Finish: stop",
  startedAt: "2026-09-19T00:00:00.000Z",
  endedAt: "2026-09-19T00:00:01.000Z",
  source: "harness",
  providerLabel: null,
  attemptOrdinal: null,
  citationIds: [],
};

const attentionEvent: RunTimelineEventView = {
  ...event,
  id: "run_event_2",
  sequence: 2,
  type: "provider.failed",
  stage: "provider",
  status: "failed",
  summary: "Provider failed",
  detail: "Retry is required.",
};

const retrievalEvent: RunTimelineEventView = {
  ...event,
  id: "run_event_3",
  sequence: 3,
  type: "retrieval.completed",
  stage: "retrieval",
  status: "running",
  summary: "Retrieval completed",
  detail: "2 sources retained.",
  source: "retrieval",
};

describe("RunTimeline export preview", () => {
  it("shows partial replay coverage as a read-only boundary", () => {
    render(
      <RunTimeline
        runId={runId}
        events={[event]}
        coverage="legacy-partial"
        coverageReason="Advisory live notification; replay is pending."
      />,
    );

    const coverage = screen.getByRole("note", { name: "Run timeline coverage" });
    expect(coverage).toHaveTextContent(/Legacy partial replay/i);
    expect(coverage).toHaveTextContent(/replay is pending/i);
  });

  it("shows the replay-to-live handoff as advisory renderer evidence", () => {
    render(
      <RunTimeline
        runId={runId}
        events={[event]}
        coverage="legacy-partial"
        handoff={{
          status: "pending",
          bufferedEventCount: 1,
          overflowed: false,
          conflict: null,
          detail: "Live events are advisory while fixed-watermark replay is pending.",
        }}
      />,
    );

    expect(screen.getByTestId("run-timeline-handoff")).toHaveTextContent(/Handoff pending/i);
    expect(screen.getByTestId("run-timeline-handoff")).toHaveTextContent(/advisory/i);
  });

  it("opens a format-switchable preview without claiming native export", () => {
    render(<RunTimeline runId={runId} events={[event]} coverage="complete" />);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const region = screen.getByRole("region", { name: "Run timeline export preview" });
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.run-timeline\.preview\.v1/i);
    expect(within(region).getByRole("note")).toHaveTextContent(/native export.*remain unavailable/i);

    fireEvent.change(within(region).getByRole("combobox", { name: "Run timeline export format" }), {
      target: { value: "markdown" },
    });
    expect(within(region).getByRole("code")).toHaveTextContent(/# Omnia run timeline preview/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/Run completed/i);
  });

  it("filters long timelines by attention state and free-text query", () => {
    render(<RunTimeline runId={runId} events={[event, attentionEvent]} coverage="complete" />);

    expect(screen.getByText("2 of 2 events")).toBeInTheDocument();
    expect(screen.getByText("Run completed")).toBeInTheDocument();
    expect(screen.getByText("Provider failed")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter run timeline view" }), {
      target: { value: "attention" },
    });
    expect(screen.getByText("1 of 2 events")).toBeInTheDocument();
    expect(screen.getByText("Provider failed")).toBeInTheDocument();
    expect(screen.queryByText("Run completed")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search run timeline" }), {
      target: { value: "does-not-match" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/No matching timeline events/i);

    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(screen.getByText("2 of 2 events")).toBeInTheDocument();
  });

  it("filters by stage and source while keeping a compact status summary", () => {
    render(<RunTimeline runId={runId} events={[event, attentionEvent, retrievalEvent]} coverage="complete" />);

    expect(screen.getByRole("region", { name: "Run event summary" })).toHaveTextContent("3 events");
    expect(screen.getByRole("region", { name: "Run event summary" })).toHaveTextContent("1 active");
    expect(screen.getByRole("combobox", { name: "Filter run timeline stage" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Filter run timeline source" })).toHaveValue("all");

    fireEvent.change(screen.getByRole("combobox", { name: "Filter run timeline stage" }), {
      target: { value: "retrieval" },
    });
    expect(screen.getByText("1 of 3 events")).toBeInTheDocument();
    expect(screen.getByText("Retrieval completed")).toBeInTheDocument();
    expect(screen.queryByText("Run completed")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter run timeline source" }), {
      target: { value: "provider" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/No matching timeline events/i);

    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(screen.getByText("3 of 3 events")).toBeInTheDocument();
  });

  it("opens retained event detail and navigates within the filtered timeline", () => {
    render(<RunTimeline runId={runId} events={[event, attentionEvent]} coverage="complete" />);

    const detail = screen.getByRole("region", { name: "Run event detail" });
    expect(detail).toHaveTextContent(/Select an event/i);

    fireEvent.click(screen.getByRole("button", { name: "Inspect event 1: Run completed" }));
    expect(detail).toHaveTextContent(/Selected event · #1/i);
    expect(detail).toHaveTextContent("run_event_1");
    expect(detail).toHaveTextContent("1.00 s");
    expect(screen.getByRole("button", { name: "Previous timeline event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next timeline event" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Next timeline event" }));
    expect(detail).toHaveTextContent(/Selected event · #2/i);
    expect(detail).toHaveTextContent("run_event_2");
    expect(detail).toHaveTextContent("Provider failed");
    expect(screen.getByRole("button", { name: "Previous timeline event" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next timeline event" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous timeline event" }));
    expect(detail).toHaveTextContent(/Selected event · #1/i);
  });
});
