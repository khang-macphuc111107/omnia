import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TrainingControlCenter, {
  initialTrainingSnapshot,
  parseTrainingPreview,
  selectedTrainingRecords,
  serializeTrainingPreview,
} from "./training-control-center";

describe("Training Control Center preview", () => {
  it("renders a truthful plan surface with admission metrics", () => {
    render(<TrainingControlCenter />);

    expect(screen.getByRole("region", { name: "Training Control Center" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Training control summary" })).toHaveTextContent(/admitted sources/i);
    expect(screen.getByText(/no model training, provider upload/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /prepare rehearsal/i })).toBeInTheDocument();
  });

  it("edits the rehearsal plan and keeps actions renderer-local", () => {
    render(<TrainingControlCenter />);

    fireEvent.change(screen.getByRole("textbox", { name: "Run label" }), { target: { value: "Correction adapter rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: /prepare rehearsal/i }));

    expect(screen.getByRole("tab", { name: /Schedule/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/no model was trained/i)).toBeInTheDocument();
    expect(screen.getByText(/approval receipt/i)).toBeInTheDocument();
  });

  it("supports dataset admission toggles and export previews", () => {
    render(<TrainingControlCenter />);

    fireEvent.click(screen.getByRole("tab", { name: "Dataset" }));
    const dataset = screen.getByRole("tabpanel");
    fireEvent.click(within(dataset).getByRole("checkbox", { name: "Helpful coding explanation" }));
    expect(screen.getByRole("status", { name: "Training control summary" })).toHaveTextContent(/2\s*admitted sources/i);

    fireEvent.click(screen.getByRole("tab", { name: "Export" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/omnia\.training-control-center\.preview\.v1/);
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/modelTraining": false/);
  });

  it("shows a redacted checkpoint manifest preview", () => {
    render(<TrainingControlCenter />);

    fireEvent.click(screen.getByRole("tab", { name: "Checkpoints" }));

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent(/checkpoint manifest/i);
    expect(panel).toHaveTextContent(/Latest rehearsal snapshot/);
    expect(panel).toHaveTextContent(/never includes model weights/i);
    expect(screen.getByRole("combobox", { name: "Checkpoint manifest format" })).toHaveValue("json");
    expect(screen.getByRole("button", { name: /download manifest/i })).toBeInTheDocument();
  });
});

describe("training preview helpers", () => {
  it("keeps held records out of selected sources and serializes the boundary", () => {
    const selected = selectedTrainingRecords(initialTrainingSnapshot);
    expect(selected.map((record) => record.id)).toEqual(["train-feedback-001", "train-feedback-002", "train-run-001"]);
    expect(serializeTrainingPreview(initialTrainingSnapshot, "markdown")).toMatch(/No model training/);
    expect(serializeTrainingPreview(initialTrainingSnapshot, "markdown")).toMatch(/Checkpoint manifest/);
  });

  it("round-trips a JSON preview and rejects unsafe enum drift", () => {
    const imported = parseTrainingPreview(serializeTrainingPreview(initialTrainingSnapshot));
    expect(imported.runName).toBe(initialTrainingSnapshot.runName);
    expect(imported.mode).toBe("supervised");
    expect(selectedTrainingRecords(imported).map((record) => record.id)).toEqual([
      "train-feedback-001",
      "train-feedback-002",
      "train-run-001",
    ]);

    const invalid = serializeTrainingPreview(initialTrainingSnapshot).replace('"mode": "supervised"', '"mode": "unsafe"');
    expect(() => parseTrainingPreview(invalid)).toThrow(/plan\.mode is unsupported/i);

    const unsafeBoundary = serializeTrainingPreview(initialTrainingSnapshot).replace('"modelTraining": false', '"modelTraining": true');
    expect(() => parseTrainingPreview(unsafeBoundary)).toThrow(/boundary\.modelTraining must remain false/i);

    const heldSource = serializeTrainingPreview(initialTrainingSnapshot).replace('"train-feedback-001",\n    "train-feedback-002"', '"train-feedback-001",\n    "train-memory-001"');
    expect(() => parseTrainingPreview(heldSource)).toThrow(/held source record/i);
  });
});
