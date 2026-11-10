import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ModelEvaluationStudio from "./model-evaluation-studio";

describe("Model Evaluation Studio preview", () => {
  it("renders the evaluation workspace with explicit renderer boundaries", () => {
    render(<ModelEvaluationStudio />);

    expect(screen.getByRole("region", { name: "Model Evaluation Studio" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Evaluation studio summary" })).toHaveTextContent(/eval cases/i);
    expect(screen.getByText(/no provider request, model training/i)).toBeInTheDocument();
    expect(screen.getByText(/Context omission ledger/i)).toBeInTheDocument();
    expect(screen.getByText(/Omnia primary route/i)).toBeInTheDocument();
  });

  it("selects a case and rehearses a deterministic score without calling a model", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Eval cases/i }));
    fireEvent.click(screen.getByRole("button", { name: /Route constraint explanation/i }));
    expect(screen.getByRole("heading", { name: /Route constraint explanation/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Prepare selected case score/i }));
    fireEvent.click(screen.getByRole("tab", { name: /Compare/i }));
    expect(screen.getByRole("row", { name: /Omnia primary route/i })).toHaveTextContent(/\/100/);
    expect(screen.getByRole("status", { name: "Evaluation studio summary" })).toHaveTextContent(/score rehearsals/i);
    expect(screen.getByText(/deterministic heuristics/i)).toBeInTheDocument();
  });

  it("explains comparison rank, coverage, leader delta, and missing rubric evidence", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Compare/i }));
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/Unranked/i);
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/0% of rubric dimensions/i);
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/Correctness/i);

    fireEvent.click(screen.getByRole("button", { name: /Rehearse selected candidate/i }));
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/#1/i);
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/100% of rubric dimensions/i);
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/\+0 points/i);
    expect(screen.getByRole("complementary", { name: "Selected comparison details" })).toHaveTextContent(/All rubric dimensions have a local score rehearsal/i);
  });

  it("switches Compare to an all-cases aggregate with honest coverage and missing-case cues", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Compare/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Comparison scope" }), { target: { value: "all-cases" } });

    expect(screen.getByRole("table", { name: "Aggregate candidate score comparison" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected aggregate comparison details" })).toHaveTextContent(/0%/i);
    expect(screen.getByRole("complementary", { name: "Selected aggregate comparison details" })).toHaveTextContent(/Cases without a score rehearsal/i);

    fireEvent.click(screen.getByRole("button", { name: /Prepare all score rehearsals/i }));
    expect(screen.getByRole("complementary", { name: "Selected aggregate comparison details" })).toHaveTextContent(/100%/i);
    expect(screen.getByRole("complementary", { name: "Selected aggregate comparison details" })).toHaveTextContent(/All evaluation cases have at least one local rubric value/i);
  });

  it("supports editable weighted rubric controls", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Rubric/i }));
    const correctness = screen.getByRole("slider", { name: "Correctness weight" });
    expect(correctness).toHaveValue("30");
    fireEvent.change(correctness, { target: { value: "40" } });
    expect(correctness).toHaveValue("40");
    expect(screen.getByRole("status", { name: "Evaluation studio summary" })).toHaveTextContent(/score rehearsals/i);
    expect(screen.getByText(/Updated Correctness rubric weight/i)).toBeInTheDocument();
  });

  it("records a renderer-local reviewer decision, note, and evidence checklist", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Review/i }));
    fireEvent.click(screen.getByRole("button", { name: /Accept/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Reviewer note/i }), { target: { value: "Boundary wording is explicit." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Boundary wording verified/i }));

    expect(screen.getByRole("button", { name: /Accept/i })).toHaveClass("is-active");
    expect(screen.getByRole("textbox", { name: /Reviewer note/i })).toHaveValue("Boundary wording is explicit.");
    expect(screen.getByRole("checkbox", { name: /Boundary wording verified/i })).toBeChecked();
    expect(screen.getByText(/no evaluator API, training label/i)).toBeInTheDocument();
  });

  it("shows a case-by-candidate matrix with an honest cell inspector", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("tab", { name: /Matrix/i }));
    expect(screen.getByRole("region", { name: "Evaluation matrix grid" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Context omission ledger/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected evaluation cell inspector" })).toHaveTextContent(/Not observed — this preview contains no candidate response/i);

    fireEvent.click(screen.getByRole("button", { name: /Context omission ledger × Research long-context/i }));
    expect(screen.getByRole("complementary", { name: "Selected evaluation cell inspector" })).toHaveTextContent(/Research long-context/i);
    expect(screen.getByRole("complementary", { name: "Selected evaluation cell inspector" })).toHaveTextContent(/no provider run, token usage, latency, or cost data/i);
  });

  it("exports JSON and Markdown previews from the quick export drawer", () => {
    render(<ModelEvaluationStudio />);

    fireEvent.click(screen.getByRole("button", { name: /Preview export/i }));
    const drawer = screen.getByRole("region", { name: "Model evaluation export preview" });
    expect(within(drawer).getByText(/omnia\.model-evaluation-studio\.preview\.v1/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Export/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Format" }), { target: { value: "markdown" } });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(/# Omnia Model Evaluation Studio preview/i)).toBeInTheDocument();
    expect(within(panel).getByText(/No provider request/i)).toBeInTheDocument();
    expect(within(panel).getByText(/Candidate comparison/i)).toBeInTheDocument();
  });
});
