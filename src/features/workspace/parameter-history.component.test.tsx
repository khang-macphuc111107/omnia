import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ContextInspectorPanel } from "./inspector";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("parameter history controls", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
  });

  it("exposes reversible controls and resets one selected option", () => {
    useWorkspaceStore.setState({
      inspectorOpen: true,
      inspectorTab: "parameters",
      parameters: { ...initialState.parameters, temperature: 1.35 },
      parameterUndoStack: [],
      parameterRedoStack: [],
    });

    render(<ContextInspectorPanel />);

    expect(screen.getByTestId("parameter-history-controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Undo/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Redo/ })).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: /Reset one option/i }), {
      target: { value: "temperature" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Reset option/i }));

    expect(useWorkspaceStore.getState().parameters.temperature).toBe(0.7);
    expect(screen.getByTestId("parameter-history-controls")).toHaveTextContent(
      /reset to its default/i,
    );
  });

  it("resets an entire parameter group as one reversible change", () => {
    useWorkspaceStore.setState({
      inspectorOpen: true,
      inspectorTab: "parameters",
      parameters: { ...initialState.parameters, temperature: 1.35, topP: 0.4, maxOutputTokens: 2048 },
      parameterUndoStack: [],
      parameterRedoStack: [],
    });

    render(<ContextInspectorPanel />);

    fireEvent.change(screen.getByRole("combobox", { name: /Reset a group/i }), {
      target: { value: "sampling" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Reset group/i }));

    const state = useWorkspaceStore.getState();
    expect(state.parameters.temperature).toBe(0.7);
    expect(state.parameters.topP).toBe(0.95);
    expect(state.parameters.maxOutputTokens).toBe(2048);
    expect(screen.getByTestId("parameter-history-controls")).toHaveTextContent(
      /sampling settings reset/i,
    );
    expect(state.parameterUndoStack).toHaveLength(1);
  });
});
