import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "./store";

describe("parameter history controls", () => {
  const original = useWorkspaceStore.getState();

  afterEach(() => {
    useWorkspaceStore.setState({
      parameters: original.parameters,
      parameterUndoStack: original.parameterUndoStack,
      parameterRedoStack: original.parameterRedoStack,
    });
  });

  it("supports reversible changes and clears redo after a new edit", () => {
    const store = useWorkspaceStore.getState();
    const initialTemperature = store.parameters.temperature;

    store.setParameter("temperature", 1.25);
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(1.25);
    expect(useWorkspaceStore.getState().parameterUndoStack).toHaveLength(1);

    useWorkspaceStore.getState().undoParameterChange();
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(initialTemperature);
    expect(useWorkspaceStore.getState().parameterRedoStack).toHaveLength(1);

    useWorkspaceStore.getState().redoParameterChange();
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(1.25);

    useWorkspaceStore.getState().setParameter("topP", 0.6);
    expect(useWorkspaceStore.getState().parameterRedoStack).toHaveLength(0);
  });

  it("resets a single option and imports partial settings as one history step", () => {
    const store = useWorkspaceStore.getState();
    store.setParameter("temperature", 1.25);
    store.setParameter("topP", 0.6);
    const beforeReset = useWorkspaceStore.getState().parameters;

    useWorkspaceStore.getState().resetParameter("temperature");
    expect(useWorkspaceStore.getState().parameters.temperature).toBe(0.7);
    expect(useWorkspaceStore.getState().parameters.topP).toBe(0.6);

    useWorkspaceStore.getState().replaceParameters({ maxRetries: 5, streaming: false });
    expect(useWorkspaceStore.getState().parameters.maxRetries).toBe(5);
    expect(useWorkspaceStore.getState().parameters.streaming).toBe(false);
    expect(useWorkspaceStore.getState().parameterUndoStack).toContainEqual(beforeReset);
  });
});
