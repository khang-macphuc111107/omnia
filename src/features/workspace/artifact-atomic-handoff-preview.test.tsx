import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ArtifactView } from "./types";
import ArtifactAtomicHandoffPreview from "./artifact-atomic-handoff-preview";

const artifact: ArtifactView = {
  id: "artifact-atomic",
  name: "research-notes.md",
  type: "Markdown",
  projectName: "Omnia",
  updatedLabel: "just now",
  sizeLabel: "4 KB",
  versionCount: 3,
};

describe("ArtifactAtomicHandoffPreview", () => {
  it("shows the exact source and supports a renderer-local staging action", () => {
    render(<ArtifactAtomicHandoffPreview artifact={artifact} revision={2} />);
    fireEvent.click(screen.getByText("Atomic handoff rehearsal"));

    expect(screen.getByText("research-notes.md")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    const stage = screen.getByRole("button", { name: /stage preview/i });
    expect(stage).toBeEnabled();
    fireEvent.click(stage);
    expect(screen.getByRole("status")).toHaveTextContent(/Staged the renderer-local handoff intent/i);
  });

  it("switches destinations and blocks a bridge until its model revision is explicit", () => {
    render(<ArtifactAtomicHandoffPreview artifact={artifact} revision={1} />);
    fireEvent.click(screen.getByText("Atomic handoff rehearsal"));
    fireEvent.change(screen.getByLabelText("Artifact handoff destination"), { target: { value: "bridge-plan" } });

    expect(screen.getByLabelText("Artifact handoff model profile revision")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stage preview/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Artifact handoff model profile revision"), { target: { value: "profile-rev-2" } });
    expect(screen.getByRole("button", { name: /stage preview/i })).toBeEnabled();
  });

  it("keeps chat scope controls visible and blocks an empty destination", () => {
    render(<ArtifactAtomicHandoffPreview artifact={artifact} revision={1} />);
    fireEvent.click(screen.getByText("Atomic handoff rehearsal"));
    fireEvent.change(screen.getByLabelText("Artifact handoff destination id"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /stage preview/i })).toBeDisabled();
    expect(screen.getByText(/Destination identity is required/i)).toBeInTheDocument();
  });
});

