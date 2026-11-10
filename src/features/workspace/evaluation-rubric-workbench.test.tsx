import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import EvaluationRubricWorkbench, {
  normalizeRubricWeights,
  presetRubric,
  rubricWeightTotal,
} from "./evaluation-rubric-workbench";

const initial = presetRubric("balanced");

describe("Evaluation Rubric Workbench preview", () => {
  it("normalizes weighted criteria deterministically", () => {
    const normalized = normalizeRubricWeights([
      { id: "a", label: "A", description: "a", weight: 1, tone: "blue" },
      { id: "b", label: "B", description: "b", weight: 1, tone: "green" },
      { id: "c", label: "C", description: "c", weight: 0, tone: "amber" },
    ]);

    expect(rubricWeightTotal(normalized)).toBe(100);
    expect(normalized.map((dimension) => dimension.weight)).toEqual([50, 50, 0]);

    const zeroTail = normalizeRubricWeights([
      { id: "a", label: "A", description: "a", weight: 1, tone: "blue" },
      { id: "b", label: "B", description: "b", weight: 1, tone: "green" },
      { id: "c", label: "C", description: "c", weight: 1, tone: "amber" },
      { id: "d", label: "D", description: "d", weight: 1, tone: "coral" },
      { id: "e", label: "E", description: "e", weight: 1, tone: "blue" },
      { id: "f", label: "F", description: "f", weight: 1, tone: "green" },
      { id: "g", label: "G", description: "g", weight: 0, tone: "amber" },
    ]);
    expect(rubricWeightTotal(zeroTail)).toBe(100);
  });

  it("switches presets and exposes editable score policy controls", () => {
    const onChange = vi.fn();
    render(<EvaluationRubricWorkbench dimensions={initial} onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Rubric preset" }), { target: { value: "coding" } });
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ label: "Implementation fit" }),
    ]), expect.objectContaining({ preset: "coding" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Rubric score scale" }), { target: { value: "1–5" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Rubric adjudication" }), { target: { value: "consensus" } });
    expect(onChange).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ scoreScale: "1–5" }));
    expect(onChange).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ adjudication: "consensus" }));
  });

  it("adds and removes a custom criterion in the renderer preview", () => {
    const onChange = vi.fn();
    render(<EvaluationRubricWorkbench dimensions={initial} onChange={onChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "New rubric criterion name" }), { target: { value: "API contract fit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New rubric criterion guidance" }), { target: { value: "Check endpoint and schema compatibility." } });
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));

    const updated = onChange.mock.calls.at(-1)?.[0] as Array<{ label: string; description: string }>;
    expect(updated).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "API contract fit", description: "Check endpoint and schema compatibility." }),
    ]));

    const rerendered = updated.map((dimension, index) => ({ ...dimension, id: `criterion-${index}`, weight: 10, tone: "blue" as const }));
    render(<EvaluationRubricWorkbench dimensions={rerendered} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove API contract fit criterion" }));
    expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(rerendered.length - 1);
  });

  it("normalizes from the toolbar and announces the preview boundary", () => {
    const onChange = vi.fn();
    render(<EvaluationRubricWorkbench dimensions={initial.map((dimension) => ({ ...dimension, weight: 1 }))} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Normalize to 100%/i }));
    expect(rubricWeightTotal(onChange.mock.calls.at(-1)?.[0] ?? [])).toBe(100);
    expect(screen.getByText(/renderer-local and reversible/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Rubric weight summary" })).toHaveTextContent(/Ready for rehearsal|Needs normalization/);
  });
});
