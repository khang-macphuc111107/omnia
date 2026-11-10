import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LearningLoopLab, { buildLearningDataPreview, computeNextLearningReviewOccurrence, DEFAULT_LEARNING_REVIEW_SCHEDULE } from "./learning-loop-lab";

describe("Learning Loop Lab preview", () => {
  it("calculates the next review occurrence without creating a scheduler", () => {
    const result = computeNextLearningReviewOccurrence({
      schedule: { ...DEFAULT_LEARNING_REVIEW_SCHEDULE, enabled: true, cadence: "daily", startDate: "2026-09-27", localTime: "09:00" },
      now: new Date(2026, 8, 27, 10, 0),
    });
    expect(result?.getDate()).toBe(28);
    expect(result?.getHours()).toBe(9);
    expect(computeNextLearningReviewOccurrence({ schedule: DEFAULT_LEARNING_REVIEW_SCHEDULE, now: new Date(2026, 8, 27) })).toBeNull();
  });

  it("renders an editable review cadence rehearsal with explicit boundaries", () => {
    render(<LearningLoopLab />);
    fireEvent.click(screen.getByRole("button", { name: /review schedule/i }));
    const schedule = screen.getByRole("region", { name: "Learning review schedule preview" });
    expect(schedule).toHaveTextContent(/no timer, background task, reminder/i);
    fireEvent.click(within(schedule).getByLabelText("Enable review schedule draft"));
    expect(within(schedule).getByLabelText("Next learning review occurrence")).toBeInTheDocument();
    fireEvent.change(within(schedule).getByLabelText("Learning review cadence"), { target: { value: "monthly" } });
    expect(within(schedule).getByLabelText("Learning review month day")).toBeInTheDocument();
    expect(within(schedule).queryByLabelText("Learning review weekday")).not.toBeInTheDocument();
  });

  it("shows inspectable stages and event detail without claiming training", () => {
    render(<LearningLoopLab />);

    expect(screen.getByRole("region", { name: "Learning loop lab" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Learning loop summary" })).toHaveTextContent(/events/i);
    expect(screen.getByText(/no model training/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /helpful answer signal/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /correction signal/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/user correction/i);
    expect(screen.getByText(/renderer-local only/i)).toBeInTheDocument();
  });

  it("advances, replays, and undoes a selected event in the renderer preview", () => {
    render(<LearningLoopLab />);

    fireEvent.click(screen.getByRole("button", { name: /correction signal/i }));
    fireEvent.click(screen.getByRole("button", { name: /advance preview/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/needs review/i);

    fireEvent.click(screen.getByRole("button", { name: /replay signal/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/captured/i);

    fireEvent.click(screen.getByRole("button", { name: /undo learning loop preview change/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/needs review/i);
  });

  it("stages renderer-local review decisions and keeps them undoable", () => {
    render(<LearningLoopLab />);

    fireEvent.click(screen.getByRole("button", { name: /correction signal/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/unreviewed/i);

    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/exclude/i);
    fireEvent.click(screen.getByRole("button", { name: "Data preview" }));
    expect(screen.getByRole("region", { name: "Learning data preview" })).toHaveTextContent(/excluded by the renderer-session review decision/i);
    fireEvent.click(screen.getByRole("button", { name: "Hide data" }));

    fireEvent.click(screen.getByRole("button", { name: /undo learning loop preview change/i }));
    expect(screen.getByRole("complementary", { name: "Selected learning loop event" })).toHaveTextContent(/unreviewed/i);

    fireEvent.click(screen.getByRole("button", { name: "Needs approval" }));
    fireEvent.click(screen.getByRole("button", { name: "Data preview" }));
    expect(screen.getByRole("region", { name: "Learning data preview" })).toHaveTextContent(/needs approval/i);
  });

  it("exports filtered JSON/Markdown previews with explicit renderer boundaries", () => {
    render(<LearningLoopLab />);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const region = screen.getByRole("region", { name: "Learning loop export preview" });
    expect(region).toHaveTextContent(/no durable write/i);
    expect(within(region).getByRole("combobox", { name: "Learning loop export format" })).toHaveValue("json");
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.learning-loop-preview\.v1/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/eligibleEventIds/i);

    fireEvent.change(within(region).getByRole("combobox", { name: "Learning loop export format" }), { target: { value: "markdown" } });
    expect(within(region).getByRole("code")).toHaveTextContent(/# Omnia learning loop preview/i);
  });

  it("previews a configurable review batch without training or durable writes", () => {
    render(<LearningLoopLab />);

    fireEvent.click(screen.getByRole("button", { name: /review batch/i }));
    const batch = screen.getByRole("region", { name: "Learning review batch preview" });
    expect(batch).toHaveTextContent(/eligible examples/i);
    expect(within(batch).getByRole("textbox", { name: "Learning batch name" })).toHaveValue("Weekly quality review");
    expect(within(batch).getByRole("spinbutton", { name: "Learning batch minimum confidence" })).toHaveValue(0);

    fireEvent.change(within(batch).getByRole("textbox", { name: "Learning batch name" }), { target: { value: "Correction audit" } });
    fireEvent.change(within(batch).getByRole("spinbutton", { name: "Learning batch minimum confidence" }), { target: { value: "90" } });
    fireEvent.click(within(batch).getByRole("button", { name: /simulate evaluation/i }));
    expect(screen.getByText(/simulated correction audit/i)).toBeInTheDocument();
    expect(screen.getByText(/no model was trained/i)).toBeInTheDocument();
    expect(within(batch).getByRole("status", { name: "Learning batch evaluation summary" })).toHaveTextContent(/mean confidence/i);
    expect(within(batch).getByText(/1 eligible example/i)).toBeInTheDocument();
  });

  it("opens a metadata-only data inventory with deterministic split and policy filters", () => {
    render(<LearningLoopLab />);

    fireEvent.click(screen.getByRole("button", { name: "Data preview" }));
    const preview = screen.getByRole("region", { name: "Learning data preview" });
    expect(preview).toHaveTextContent(/no raw payload/i);
    expect(within(preview).getByRole("status", { name: "Learning data preview summary" })).toHaveTextContent(/eligible/i);
    expect(within(preview).getByRole("table", { name: "Learning data preview rows" })).toBeInTheDocument();
    expect(preview).toHaveTextContent(/renderer-session projection/i);

    fireEvent.change(within(preview).getByRole("combobox", { name: "Learning data row filter" }), { target: { value: "held" } });
    expect(within(preview).getByRole("status", { name: "Learning data preview summary" })).toHaveTextContent(/held/i);
    expect(within(preview).getAllByText(/blocked stage|excluded by the local input policy|confidence floor/i).length).toBeGreaterThan(0);
  });
});

describe("learning data preview helpers", () => {
  it("keeps row assignment stable and never includes raw payload fields", () => {
    render(<LearningLoopLab />);
    fireEvent.click(screen.getByRole("button", { name: "Data preview" }));
    const preview = screen.getByRole("region", { name: "Learning data preview" });
    const firstSource = within(preview).getByText("Helpful answer signal");
    expect(firstSource).toBeInTheDocument();
    expect(preview).not.toHaveTextContent(/accurate and actionable/i);
    expect(preview).not.toHaveTextContent(/user marked a response/i);
  });

  it("derives explicit consent, redaction, and eligibility reasons", () => {
    const snapshot = {
      events: [],
      includeFeedback: true,
      includeApprovedMemories: true,
      includeRunOutcomes: false,
      reviewDecisions: { "x-feedback": "exclude" as const },
      batchName: "Preview",
      batchObjective: "quality" as const,
      batchLimit: 12,
      batchConfidenceFloor: 0.9,
    };
    const rows = buildLearningDataPreview(snapshot, [
      { id: "x-feedback", kind: "feedback", stage: "review", title: "Feedback", detail: "raw detail", source: "Feedback", evidence: "label", impact: "impact", nextAction: "review", confidence: 0.95, occurredAt: "now" },
      { id: "x-memory", kind: "proposal", stage: "review", title: "Memory", detail: "raw detail", source: "Memory", evidence: "proposal", impact: "impact", nextAction: "approve", confidence: 0.8, occurredAt: "now" },
      { id: "x-run", kind: "signal", stage: "captured", title: "Run", detail: "raw detail", source: "Run", evidence: "marker", impact: "impact", nextAction: "hold", confidence: 0.95, occurredAt: "now" },
    ]);

    expect(rows.find((row) => row.id === "x-feedback")).toMatchObject({ eligibility: "held", reviewDecision: "exclude", consent: "approved preview", redaction: "metadata only", reason: expect.stringMatching(/excluded by the renderer-session/i) });
    expect(rows.find((row) => row.id === "x-memory")).toMatchObject({ eligibility: "held", consent: "pending review", redaction: "masked preview" });
    expect(rows.find((row) => row.id === "x-run")).toMatchObject({ eligibility: "held", reason: expect.stringMatching(/run outcomes/i) });
    expect(rows.every((row) => !Object.prototype.hasOwnProperty.call(row, "detail"))).toBe(true);
  });
});
