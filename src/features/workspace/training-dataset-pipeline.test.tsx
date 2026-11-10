import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TrainingRecord } from "./training-control-center";
import TrainingDatasetPipeline, {
  buildDatasetPipelineProjection,
  initialDatasetPipelineSnapshot,
  parseDatasetPipelinePreview,
  selectedDatasetPipelineRecords,
  serializeDatasetPipelinePreview,
} from "./training-dataset-pipeline";

const records: TrainingRecord[] = [
  {
    id: "train-feedback-001",
    title: "Helpful coding explanation",
    source: "Feedback review",
    examples: 18,
    sensitivity: "low",
    eligible: true,
    selected: true,
    note: "Approved quality signal.",
  },
  {
    id: "train-feedback-002",
    title: "Correction and rewrite pair",
    source: "Feedback review",
    examples: 12,
    sensitivity: "moderate",
    eligible: true,
    selected: true,
    note: "Contrast pair.",
  },
  {
    id: "train-memory-001",
    title: "Held memory proposal",
    source: "Memory proposal",
    examples: 6,
    sensitivity: "high",
    eligible: false,
    selected: false,
    note: "Held.",
  },
];

describe("Dataset Pipeline preview", () => {
  it("renders deterministic preparation stages and explicit boundaries", () => {
    render(<TrainingDatasetPipeline records={records} />);

    expect(screen.getByRole("region", { name: "Dataset pipeline preview" })).toBeInTheDocument();
    expect(screen.getByText("Dataset Pipeline")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Dataset pipeline summary" })).toHaveTextContent(/raw examples/i);
    expect(screen.getByRole("region", { name: "Dataset pipeline preview" })).toHaveTextContent(/no filesystem read/i);
    expect(screen.getByText(/Source manifest/i)).toBeInTheDocument();
  });

  it("updates split policy with reversible controls", () => {
    render(<TrainingDatasetPipeline records={records} />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Dataset validation percent" }), { target: { value: "25" } });
    expect(screen.getByRole("spinbutton", { name: "Dataset test percent" })).toHaveValue(5);
    expect(screen.getByRole("status", { name: "Dataset pipeline summary" })).toHaveTextContent(/train \/ val \/ test/i);
    fireEvent.click(screen.getByRole("button", { name: "Undo dataset pipeline preview change" }));
    expect(screen.getByRole("spinbutton", { name: "Dataset test percent" })).toHaveValue(10);
  });

  it("shows a portable export with false runtime boundaries", () => {
    render(<TrainingDatasetPipeline records={records} />);

    fireEvent.click(screen.getByRole("button", { name: /preview export/i }));
    const exportRegion = screen.getByRole("region", { name: "Dataset pipeline export preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.training-dataset-pipeline\.preview\.v1/i);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"modelTraining": false/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/"durableDatasetWrite": false/);
  });

  it("edits the visible source manifest, updates split projections, and keeps changes undoable", () => {
    render(<TrainingDatasetPipeline records={records} />);

    const manifest = screen.getByRole("region", { name: "Dataset source manifest controls" });
    const firstRecord = within(manifest).getByRole("checkbox", { name: "Include Helpful coding explanation in dataset preview" });
    expect(firstRecord).toBeChecked();
    expect(within(manifest).getByRole("checkbox", { name: "Include Held memory proposal in dataset preview" })).toBeDisabled();

    fireEvent.click(firstRecord);
    expect(screen.getByRole("status", { name: "Dataset pipeline summary" })).toHaveTextContent(/12\s*raw examples/i);
    expect(within(manifest).getByRole("status")).toHaveTextContent(/1\/2 eligible sources included/i);

    fireEvent.click(screen.getByRole("button", { name: "Undo dataset pipeline preview change" }));
    expect(within(manifest).getByRole("checkbox", { name: "Include Helpful coding explanation in dataset preview" })).toBeChecked();
    expect(screen.getByRole("status", { name: "Dataset pipeline summary" })).toHaveTextContent(/30\s*raw examples/i);
  });

  it("filters manifest rows and exports only included, eligible source IDs", () => {
    render(<TrainingDatasetPipeline records={records} />);

    const manifest = screen.getByRole("region", { name: "Dataset source manifest controls" });
    fireEvent.change(within(manifest).getByRole("combobox", { name: "Dataset source manifest filter" }), { target: { value: "ineligible" } });
    expect(within(manifest).getByRole("checkbox", { name: "Include Held memory proposal in dataset preview" })).toBeDisabled();
    expect(within(manifest).queryByRole("checkbox", { name: "Include Helpful coding explanation in dataset preview" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /preview export/i }));
    const exportRegion = screen.getByRole("region", { name: "Dataset pipeline export preview" });
    const payload = JSON.parse(within(exportRegion).getByRole("code").textContent ?? "{}") as { sourceRecordIds: string[] };
    expect(payload.sourceRecordIds).toEqual(["train-feedback-001", "train-feedback-002"]);
    expect(within(exportRegion).getByRole("code")).not.toHaveTextContent(/Held memory proposal/);
  });
});

describe("dataset pipeline helpers", () => {
  it("projects duplicates, holdout counts, and review checks without raw content", () => {
    const projection = buildDatasetPipelineProjection(records, initialDatasetPipelineSnapshot());

    expect(projection.rawExamples).toBe(30);
    expect(projection.duplicateExamplesRemoved).toBe(3);
    expect(projection.sensitiveExamplesHeld).toBe(1);
    expect(projection.leakageExamplesHeld).toBe(1);
    expect(projection.eligibleExamples).toBe(25);
    expect(projection.trainExamples + projection.validationExamples + projection.testExamples).toBe(25);
    expect(projection.checks.some((check) => check.id === "leakage" && check.status === "ready")).toBe(true);
  });

  it("round-trips JSON and rejects boundary drift", () => {
    const serialized = serializeDatasetPipelinePreview(records, initialDatasetPipelineSnapshot());
    const imported = parseDatasetPipelinePreview(serialized);
    expect(imported.splitStrategy).toBe("stratified");
    expect(imported.testPercent).toBe(10);

    const unsafe = serialized.replace('"modelTraining": false', '"modelTraining": true');
    expect(() => parseDatasetPipelinePreview(unsafe)).toThrow(/boundary\.modelTraining/i);

    const invalidSplit = serialized.replace('"testPercent": 10', '"testPercent": 11');
    expect(() => parseDatasetPipelinePreview(invalidSplit)).toThrow(/must equal 100/i);

  });

  it("honors explicit renderer-session manifest inclusion and ignores ineligible IDs", () => {
    const snapshot = { ...initialDatasetPipelineSnapshot(), includedRecordIds: ["train-feedback-002", "train-memory-001", "unknown-id"] };
    const selected = selectedDatasetPipelineRecords(records, snapshot);
    expect(selected.map((record) => record.id)).toEqual(["train-feedback-002"]);
    expect(buildDatasetPipelineProjection(records, snapshot)).toMatchObject({ rawExamples: 12, selectedRecordIds: ["train-feedback-002"] });

    const serialized = serializeDatasetPipelinePreview(records, snapshot);
    expect(JSON.parse(serialized).sourceRecordIds).toEqual(["train-feedback-002"]);
    const unsafeManifest = JSON.parse(serialized) as { plan: { includedRecordIds?: unknown } };
    unsafeManifest.plan.includedRecordIds = [true];
    expect(() => parseDatasetPipelinePreview(JSON.stringify(unsafeManifest))).toThrow(/includedRecordIds/i);
  });
});
