import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import RlaifLabPreview, { summarizeRlaifAnnotationQuality, summarizeRlaifReviews } from "./rlaif-lab-preview";

describe("RLAIF Lab preview", () => {
  it("renders the evaluator contract and explicit renderer boundary", () => {
    render(<RlaifLabPreview />);

    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toBeInTheDocument();
    expect(screen.getByText(/no evaluator\/model request/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "RLAIF optimization recipe" })).toHaveValue("DPO");
    expect(screen.getByText(/pairwise preference review/i)).toBeInTheDocument();
  });

  it("records reversible pairwise labels without claiming a training run", () => {
    render(<RlaifLabPreview />);
    const groups = screen.getAllByRole("group");
    const firstGroup = groups[0];
    if (!firstGroup) throw new Error("Expected at least one illustrative comparison group");
    fireEvent.click(within(firstGroup).getByRole("button", { name: "Prefer A" }));

    expect(within(firstGroup).getByRole("button", { name: "Prefer A" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByText("illustrative comparisons reviewed")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/illustrative comparison decision/i);
  });

  it("supports undo and reset for local configuration changes", () => {
    render(<RlaifLabPreview />);
    const recipe = screen.getByRole("combobox", { name: "RLAIF reward rubric" });
    fireEvent.change(recipe, { target: { value: "Groundedness + citations" } });
    expect(recipe).toHaveValue("Groundedness + citations");
    fireEvent.click(screen.getByRole("button", { name: "Undo RLAIF preview change" }));
    expect(recipe).toHaveValue("Correctness + usefulness");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(recipe).toHaveValue("Correctness + usefulness");
  });

  it("rehearses deterministic blind order and clears labels when the order changes", () => {
    render(<RlaifLabPreview />);
    const groups = screen.getAllByRole("group");
    const firstGroup = groups[0];
    if (!firstGroup) throw new Error("Expected at least one illustrative comparison group");
    fireEvent.click(within(firstGroup).getByRole("button", { name: "Prefer A" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Rationale for comparison 1" }), { target: { value: "correctness" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Confidence for comparison 1" }), { target: { value: "high" } });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "RLAIF annotation completeness" })).toHaveTextContent(/1.*complete of 3.*33%/i);

    fireEvent.change(screen.getByRole("textbox", { name: "RLAIF blind order seed" }), { target: { value: "alternate-seed" } });
    expect(screen.getByText("0/3")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rationale for comparison 1" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Confidence for comparison 1" })).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(/visible slot order changed/i);
    expect(screen.getByText(/deterministic slot orders/i)).toBeInTheDocument();
  });

  it("requires a rationale and reviewer confidence for a complete local annotation", () => {
    render(<RlaifLabPreview />);
    const preference = screen.getByRole("combobox", { name: "Rationale for comparison 1" });
    const confidence = screen.getByRole("combobox", { name: "Confidence for comparison 1" });
    expect(preference).toBeDisabled();
    expect(confidence).toBeDisabled();

    const firstGroup = screen.getAllByRole("group")[0];
    if (!firstGroup) throw new Error("Expected at least one illustrative comparison group");
    fireEvent.click(within(firstGroup).getByRole("button", { name: "Prefer A" }));
    fireEvent.change(preference, { target: { value: "groundedness" } });
    fireEvent.change(confidence, { target: { value: "medium" } });

    expect(screen.getByText("Annotation complete")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toHaveTextContent(/groundedness/);
    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toHaveTextContent(/medium/);
  });

  it("keeps swap-test rehearsal visibly planned rather than executed", () => {
    render(<RlaifLabPreview />);
    expect(screen.getByText(/Planned · not run/i)).toBeInTheDocument();
    const swapToggle = screen.getByRole("checkbox", { name: /Swap-test rehearsal/i });
    fireEvent.click(swapToggle);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toHaveTextContent(/no evaluator\/model request/i);
  });

  it("exposes a redacted review checkpoint export preview", () => {
    render(<RlaifLabPreview />);

    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toHaveTextContent(/review checkpoint/i);
    expect(screen.getByRole("combobox", { name: "RLAIF review export format" })).toHaveValue("json");
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "RLAIF Lab" })).toHaveTextContent(/no evaluator\/model request/i);
  });
});

describe("RLAIF preview helpers", () => {
  it("keeps unresolved judgments distinct from reviewed labels", () => {
    expect(summarizeRlaifReviews([
      { id: "a", prompt: "p", responseA: "a", responseB: "b", preference: "prefer-a" },
      { id: "b", prompt: "p", responseA: "a", responseB: "b", preference: "abstain", rationale: null, confidence: null },
      { id: "c", prompt: "p", responseA: "a", responseB: "b", preference: null, rationale: null, confidence: null },
    ])).toEqual({ reviewed: 2, preferA: 1, preferB: 0, ties: 0, abstentions: 1, unresolved: 1 });
  });

  it("summarizes only fully labeled preference examples as complete", () => {
    expect(summarizeRlaifAnnotationQuality([
      { id: "a", prompt: "p", responseA: "a", responseB: "b", preference: "prefer-a", rationale: "correctness", confidence: "high" },
      { id: "b", prompt: "p", responseA: "a", responseB: "b", preference: "tie", rationale: null, confidence: "medium" },
      { id: "c", prompt: "p", responseA: "a", responseB: "b", preference: null, rationale: null, confidence: null },
    ])).toEqual({ complete: 1, incomplete: 2, coveragePercent: 33, missingRationale: 1, missingConfidence: 0 });
  });
});
