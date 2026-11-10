import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ComposerModeControlsPreview } from "./composer-mode-controls-preview";

describe("ComposerModeControlsPreview", () => {
  it("renders Ask controls with a renderer-only boundary", () => {
    render(<ComposerModeControlsPreview mode="ask" />);

    expect(screen.getByRole("region", { name: "Ask mode controls" })).toBeInTheDocument();
    expect(screen.getByLabelText("Answer style")).toHaveValue("balanced");
    expect(screen.getByLabelText("Response format")).toHaveValue("markdown");
    expect(screen.getByRole("note")).toHaveTextContent(/renderer-local preview/i);
  });

  it("keeps independent values for each mode and resets the selected mode", () => {
    const { rerender } = render(<ComposerModeControlsPreview mode="create" />);
    const artifactDirection = screen.getByLabelText("Artifact direction");

    fireEvent.change(artifactDirection, { target: { value: "code" } });
    expect(artifactDirection).toHaveValue("code");

    rerender(<ComposerModeControlsPreview mode="research" />);
    expect(screen.getByLabelText("Research depth")).toHaveValue("focused");

    rerender(<ComposerModeControlsPreview mode="create" />);
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("code");
    expect(screen.getByRole("button", { name: "Undo Create control change" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Undo Create control change" }));
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("document");
    expect(screen.getByRole("button", { name: "Redo Create control change" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo Create control change" }));
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("code");
    fireEvent.click(screen.getByRole("button", { name: "Reset Create controls" }));
    expect(screen.getByLabelText("Artifact direction")).toHaveValue("document");
  });

  it("supports toggle controls without implying a native write", () => {
    render(<ComposerModeControlsPreview mode="research" />);
    const unknowns = screen.getByRole("checkbox", { name: /Flag unknowns and conflicts/i });

    expect(unknowns).toBeChecked();
    fireEvent.click(unknowns);
    expect(unknowns).not.toBeChecked();
    expect(screen.getByText(/not sent as native\/provider parameters/i)).toBeInTheDocument();
  });

  it("exposes bounded discussion controls without claiming agent orchestration", () => {
    render(<ComposerModeControlsPreview mode="discuss" />);

    expect(screen.getByRole("region", { name: "Discuss mode controls" })).toBeInTheDocument();
    expect(screen.getByLabelText("Discussion rounds")).toHaveValue("3");
    expect(screen.getByLabelText("Perspective mix")).toHaveValue("specialists");
    expect(screen.getByLabelText("Synthesis")).toHaveValue("decision");
    expect(screen.getByRole("checkbox", { name: /Keep disagreements visible/i })).toBeChecked();
    expect(screen.getByRole("note")).toHaveTextContent(/renderer-local preview/i);

    fireEvent.change(screen.getByLabelText("Discussion rounds"), { target: { value: "4" } });
    expect(screen.getByLabelText("Discussion rounds")).toHaveValue("4");
    fireEvent.click(screen.getByRole("button", { name: "Undo Discuss control change" }));
    expect(screen.getByLabelText("Discussion rounds")).toHaveValue("3");
  });
});
