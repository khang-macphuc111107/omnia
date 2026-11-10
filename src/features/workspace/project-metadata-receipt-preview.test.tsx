import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createProjectMetadataReceiptPreview,
} from "./project-metadata-receipt-preview";
import { ProjectMetadataReceiptPreview } from "./project-metadata-receipt-preview";

const receipt = createProjectMetadataReceiptPreview({
  projectId: "project-1",
  mode: "browser-preview",
  outcome: "applied",
  before: { name: "Omnia", description: "Workspace", instructions: "Be precise." },
  after: { name: "Omnia Desktop", description: "Workspace", instructions: "Be precise." },
  detail: "Renderer-local metadata preview applied.",
  sequence: 1,
  recordedAt: "2026-09-25T10:00:00.000Z",
});

describe("ProjectMetadataReceiptPreview", () => {
  it("renders the bounded observation list and export boundary", () => {
    render(<ProjectMetadataReceiptPreview projectId="project-1" receipts={[receipt]} />);

    const region = screen.getByRole("region", { name: "Project metadata receipt preview" });
    expect(within(region).getByText("Browser preview applied")).toBeInTheDocument();
    expect(within(region).getByText("Project name")).toBeInTheDocument();
    expect(within(region).getByText("Renderer observation")).toBeInTheDocument();
    expect(within(region).getAllByText(/does not prove a durable mutation receipt/i).length).toBeGreaterThan(0);
    expect(within(region).getByRole("button", { name: "Copy" })).toBeEnabled();
  });

  it("switches export format and clears session observations through the callback", () => {
    const onClear = vi.fn();
    render(<ProjectMetadataReceiptPreview projectId="project-1" receipts={[receipt]} onClear={onClear} />);

    const region = screen.getByRole("region", { name: "Project metadata receipt preview" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Project metadata observation export format" }), {
      target: { value: "markdown" },
    });
    expect(within(region).getByLabelText("Project metadata observation export preview")).toHaveTextContent(
      "Omnia Project metadata save observation preview",
    );

    fireEvent.click(within(region).getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows a clear empty state when the session has no observations", () => {
    render(<ProjectMetadataReceiptPreview projectId="project-1" receipts={[]} />);

    const region = screen.getByRole("region", { name: "Project metadata receipt preview" });
    expect(within(region).getByText("No save observation yet")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(within(region).getByRole("button", { name: "Download" })).toBeDisabled();
  });
});
