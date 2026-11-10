import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectMetadataProvenancePreview } from "./project-metadata-provenance-preview";

const project = {
  id: "project-1",
  name: "Omnia",
  nativeUpdatedAtMs: 12,
  overview: {
    overviewRevisionId: "overview-2",
    projectTwinRevisionId: null,
    sourceEventWatermark: null,
  },
};

const baseline = {
  name: "Omnia",
  description: "Workspace",
  instructions: "Be precise.",
} as const;

describe("ProjectMetadataProvenancePreview", () => {
  it("renders source, freshness, revision gaps, and field delta", () => {
    render(
      <ProjectMetadataProvenancePreview
        project={project}
        source="native-record"
        baseline={baseline}
        draft={{ ...baseline, description: "Updated workspace" }}
        latestObservation={null}
      />,
    );

    const region = screen.getByRole("region", { name: "Project metadata provenance" });
    expect(within(region).getByText("Native Project record")).toBeInTheDocument();
    expect(within(region).getByText("Draft differs from baseline")).toBeInTheDocument();
    expect(within(region).getByText("Description")).toBeInTheDocument();
    expect(within(region).getByText("overview-2")).toBeInTheDocument();
    expect(within(region).getByText("Not hydrated")).toBeInTheDocument();
    expect(within(region).getAllByText(/does not prove a native mutation receipt/i).length).toBeGreaterThan(0);
  });

  it("switches export format and reports renderer-only copy behavior", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ProjectMetadataProvenancePreview
        project={{ ...project, nativeUpdatedAtMs: undefined }}
        source="renderer-session-preview"
        baseline={baseline}
        draft={baseline}
        latestObservation={null}
      />,
    );

    const region = screen.getByRole("region", { name: "Project metadata provenance" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Project metadata provenance export format" }), {
      target: { value: "markdown" },
    });
    expect(within(region).getByLabelText("Project metadata provenance export preview")).toHaveTextContent(
      "Omnia Project metadata provenance preview",
    );

    fireEvent.click(within(region).getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(within(region).getByText(/Copied renderer-local provenance preview/i)).toBeInTheDocument());
  });
});
