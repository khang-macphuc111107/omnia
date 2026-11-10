import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ScienceNotebookLabPreview, { buildObservationCsv } from "./science-notebook-lab-preview";

describe("ScienceNotebookLabPreview", () => {
  it("shows a renderer-only protocol with explicit boundaries", () => {
    render(<ScienceNotebookLabPreview />);

    expect(screen.getByRole("heading", { name: "Science notebook lab" })).toBeInTheDocument();
    expect(screen.getByText(/No provider call, retrieval, filesystem read, compiler, hardware control/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Science research question")).toHaveValue("How does pendulum length change its oscillation period?");
    expect(screen.getByText("Simple pendulum")).toBeInTheDocument();
  });

  it("adds and edits typed observations while calculating predicted periods", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));

    const table = screen.getByRole("table", { name: "Science notebook observations" });
    expect(within(table).getByText("1.419")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(within(table).getAllByRole("row").length).toBe(5);

    fireEvent.change(screen.getByLabelText("Length for obs-1"), { target: { value: "1.25" } });
    expect(within(table).getByText("2.243")).toBeInTheDocument();
  });

  it("supports duplicate and bulk-delete actions for selected rows", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    const table = screen.getByRole("table", { name: "Science notebook observations" });

    fireEvent.click(screen.getByLabelText("Select observation obs-1"));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate selected" }));
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByLabelText("Science notebook summary")).toHaveTextContent("4");
    expect(screen.getByText(/Duplicated 1 selected observation/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/Removed 1 selected observation/)).toBeInTheDocument();
  });

  it("previews CSV for visible or selected rows with safe field escaping", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    fireEvent.change(screen.getByLabelText("Observation note for obs-1"), { target: { value: "calibration, room" } });

    fireEvent.click(screen.getByText(/Preview CSV \(3 rows\)/));
    const preview = screen.getByRole("code");
    expect(preview).toHaveTextContent("id,length_m,measured_period_s,predicted_period_s,residual_s,note,reviewed");
    expect(preview).toHaveTextContent('"calibration, room"');

    fireEvent.click(screen.getByLabelText("Select observation obs-1"));
    fireEvent.change(screen.getByLabelText("Observation CSV scope"), { target: { value: "selected" } });
    expect(screen.getByText("Preview CSV (1 rows)")).toBeInTheDocument();
    expect(screen.getByRole("code")).toHaveTextContent("obs-1");
    expect(screen.getByRole("code")).not.toHaveTextContent("obs-2");
  });

  it("serializes observation rows as deterministic CSV", () => {
    expect(buildObservationCsv([{
      id: "obs-test",
      input: "1",
      measured: "2",
      note: "quoted, note",
      reviewed: false,
      predicted: 1.23456,
      residual: Number.NaN,
    }])).toBe([
      "id,length_m,measured_period_s,predicted_period_s,residual_s,note,reviewed",
      'obs-test,1,2,1.235,Unavailable,"quoted, note",false',
    ].join("\n"));
  });

  it("surfaces local input warnings and keeps the model fail-closed", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.change(screen.getByLabelText("Gravity"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));

    expect(screen.getByRole("status", { name: "Science notebook input review" })).toHaveTextContent(/Gravity must be/i);
    fireEvent.click(screen.getByRole("tab", { name: /Model review/ }));
    expect(screen.getByText(/Needs review/)).toBeInTheDocument();
  });

  it("supports protocol checklists, model review, and planned domain labels", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByLabelText(/Capture observations/));
    expect(screen.getByText("3/5")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Science domain"), { target: { value: "chemistry" } });
    expect(screen.getByLabelText("Science domain")).toHaveValue("chemistry");
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    expect(screen.getByRole("status", { name: "Science notebook input review" })).toHaveTextContent(/Chemistry model templates are planned/i);
  });

  it("supports observation table presets, custom columns, density, and threshold reset", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Observations/ }));
    const table = screen.getByRole("table", { name: "Science notebook observations" });

    fireEvent.click(screen.getByText(/Table view/));
    fireEvent.change(screen.getByLabelText("Observation table view preset"), { target: { value: "review" } });
    expect(table.querySelector("thead")).not.toHaveTextContent("Predicted (s)");
    expect(table.querySelector("thead")).toHaveTextContent("Residual (s)");

    fireEvent.change(screen.getByLabelText("Observation table view preset"), { target: { value: "compact" } });
    expect(table).toHaveClass("science-notebook-lab__table--compact");
    expect(table.querySelector("thead")).not.toHaveTextContent("Note");

    fireEvent.change(screen.getByLabelText("Residual flag threshold"), { target: { value: "0.003" } });
    const residualCell = within(table).getByText("-0.004");
    expect(residualCell).toHaveClass("is-warning");

    fireEvent.click(screen.getByLabelText("Observation column Predicted period"));
    expect(table.querySelector("thead")).toHaveTextContent("Predicted (s)");
    expect(screen.getByLabelText("Observation table view preset")).toHaveValue("custom");

    fireEvent.click(screen.getByRole("button", { name: "Reset table view" }));
    expect(table).toHaveClass("science-notebook-lab__table--comfortable");
    expect(table.querySelector("thead")).toHaveTextContent("Predicted (s)");
    expect(screen.getByLabelText("Residual flag threshold")).toHaveValue("0.05");
  });

  it("exports JSON and markdown previews without claiming durable writes", () => {
    render(<ScienceNotebookLabPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Export/ }));
    const exportPanel = screen.getByRole("tabpanel", { name: "Export" });
    expect(within(exportPanel).getByRole("code")).toHaveTextContent(/omnia\.science-notebook-lab\.preview\.v1/);
    fireEvent.change(within(exportPanel).getByLabelText("Science notebook export format"), { target: { value: "markdown" } });
    expect(within(exportPanel).getByRole("code")).toHaveTextContent(/Preview only · renderer-local · no durable write/);
    expect(within(exportPanel).getByText(/Portable experiment handoff/)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across lab tabs", () => {
    render(<ScienceNotebookLabPreview />);
    const protocol = screen.getByRole("tab", { name: "Protocol" });
    fireEvent.keyDown(protocol, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Observations/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /Observations/ }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
  });
});
