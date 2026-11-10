import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PromptExperimentStudio from "./prompt-experiment-studio";

describe("PromptExperimentStudio", () => {
  it("renders prompt/persona options and keeps the preview boundary visible", () => {
    render(<PromptExperimentStudio />);

    expect(screen.getByRole("heading", { name: "Prompt / Persona Experiment Studio" })).toBeInTheDocument();
    expect(screen.getByText(/No provider request, model training, native prompt injection/i)).toBeInTheDocument();
    expect(screen.getByText("Evidence-first")).toBeInTheDocument();
    expect(screen.getByText("Production engineer")).toBeInTheDocument();
  });

  it("edits the selected prompt and prepares a deterministic pair rehearsal", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt variants/i }));
    const editor = screen.getByRole("textbox", { name: "Instruction draft" });
    fireEvent.change(editor, { target: { value: "Always show invariants before code." } });
    expect(editor).toHaveValue("Always show invariants before code.");

    fireEvent.click(screen.getByRole("button", { name: /Rehearse selected pair/i }));
    expect(screen.getByText(/Prepared a deterministic rehearsal for/i)).toBeInTheDocument();
    expect(screen.getByText("1", { selector: ".prompt-experiment__metrics strong" })).toBeInTheDocument();
  });

  it("rehearses the complete pair matrix and exposes export preview", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Pair matrix/i }));
    fireEvent.click(screen.getByRole("button", { name: /Rehearse all pairs/i }));
    expect(screen.getByText(/Prepared 12 deterministic prompt\/persona pairs/i)).toBeInTheDocument();
    expect(screen.getAllByText("Rehearsed").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Selected rehearsal score" })).toHaveTextContent(/Boundary discipline/i);
    expect(screen.getByRole("region", { name: "Selected rehearsal score" })).toHaveTextContent(/Rehearsal signal only/i);

    fireEvent.click(screen.getByRole("tab", { name: /Export/i }));
    expect(screen.getByLabelText("JSON prompt experiment export preview")).toHaveTextContent("omnia.prompt-persona-experiment.preview.v1");
  });

  it("supports duplicate, undo, and reset for prompt drafts", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt variants/i }));
    fireEvent.click(screen.getByRole("button", { name: /Duplicate/i }));
    expect(screen.getByText("Evidence-first copy")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Undo prompt experiment preview change/i }));
    expect(screen.queryByText("Evidence-first copy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Reset$/i }));
    expect(screen.getByText("Evidence-first")).toBeInTheDocument();
  });

  it("lets the preview customize metadata and invalidates stale rehearsal signals", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Pair matrix/i }));
    fireEvent.click(screen.getByRole("button", { name: /Rehearse all pairs/i }));
    expect(screen.getByText(/Prepared 12 deterministic prompt\/persona pairs/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Prompt variants/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Focus label" }), { target: { value: "Traceability" } });
    expect(screen.getByRole("textbox", { name: "Focus label" })).toHaveValue("Traceability");
    expect(screen.getByText(/Editing a variant clears its prior rehearsal signals/i)).toBeInTheDocument();
    expect(screen.getByText("—", { selector: ".prompt-experiment__metrics strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Persona packs/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Strengths" }), { target: { value: "traceability, contracts" } });
    expect(screen.getByRole("textbox", { name: "Strengths" })).toHaveValue("traceability, contracts");
  });

  it("opens the quick export preview from the export toolbar", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Export/i }));
    const toggle = screen.getByRole("button", { name: /Preview export/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("region", { name: "Quick prompt experiment export preview" })).toHaveTextContent("omnia.prompt-persona-experiment.preview.v1");
    expect(screen.getByRole("button", { name: /Hide preview/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("prepares a renderer-local Prompt Workshop with reviewer lanes and bounded next actions", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt Workshop/i }));
    expect(screen.getByText(/No workshop lane has run yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Prepare workshop rehearsal/i }));
    expect(screen.getByText(/Prepared 3 deterministic workshop lanes/i)).toBeInTheDocument();
    expect(screen.getByText("CSE coach")).toBeInTheDocument();
    expect(screen.getByText("Evidence reviewer")).toBeInTheDocument();
    expect(screen.getByText("Suggested next actions")).toBeInTheDocument();
    expect(screen.getByText(/budgets and stop conditions stay visible/i)).toBeInTheDocument();
  });

  it("shows a semantic Enhance diff and applies it only after explicit confirmation", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt variants/i }));
    fireEvent.click(screen.getByRole("button", { name: /Enhance/i }));
    expect(screen.getByRole("region", { name: /Prompt enhancement semantic diff/i })).toHaveTextContent(/Suggested additions/i);
    expect(screen.getByText(/no model critique, provider request, or automatic send/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Apply to draft/i }));
    expect(screen.getByText(/Applied the semantic enhancement/i)).toBeInTheDocument();
  });

  it("offers local prompt suggestions that append to the draft only when selected", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt variants/i }));
    expect(screen.getByRole("button", { name: /State assumptions/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /State assumptions/i }));
    expect((screen.getByRole("textbox", { name: "Instruction draft" }) as HTMLTextAreaElement).value).toContain("State assumptions and unknowns");
    expect(screen.getByText(/nothing is sent automatically/i)).toBeInTheDocument();
  });

  it("keeps next-action mode selection as a staged renderer preview", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt Workshop/i }));
    const mode = screen.getByRole("combobox", { name: /Add one worked example mode/i });
    fireEvent.change(mode, { target: { value: "run" } });
    fireEvent.click(screen.getByRole("button", { name: /Stage Add one worked example preview/i }));
    expect(screen.getByText(/Staged “Add one worked example” as run/i)).toBeInTheDocument();
    expect(screen.getByText(/never creates a queue item, spends budget, calls a provider/i)).toBeInTheDocument();
  });

  it("compares two prompt variants with a bounded local line diff", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt compare/i }));
    expect(screen.getByRole("combobox", { name: "Baseline prompt variant" })).toHaveValue("variant-baseline");
    expect(screen.getByRole("combobox", { name: "Challenger prompt variant" })).toHaveValue("variant-evidence");
    expect(screen.getByRole("region", { name: "Prompt line diff" })).toHaveTextContent("evidence");
    expect(screen.getByText(/rough token delta/i)).toBeInTheDocument();
    expect(screen.getByText(/no model call/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Swap sides/i }));
    expect(screen.getByRole("combobox", { name: "Baseline prompt variant" })).toHaveValue("variant-evidence");
    expect(screen.getByRole("combobox", { name: "Challenger prompt variant" })).toHaveValue("variant-baseline");
  });

  it("opens either compared draft in the existing prompt editor", () => {
    render(<PromptExperimentStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Prompt compare/i }));
    fireEvent.click(screen.getByRole("button", { name: /Edit challenger/i }));
    expect(screen.getByRole("tab", { name: /Prompt variants/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Variant name" })).toHaveValue("Evidence-first");
    expect(screen.getByText(/This text is an editable draft only/i)).toBeInTheDocument();
  });
});
