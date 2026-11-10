import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectTwinEdgeEvidencePreview } from "./project-twin-edge-evidence-preview";
import type { ProjectView } from "./types";

const project: Pick<ProjectView, "id" | "name" | "folders"> = {
  id: "project-twin-preview",
  name: "Twin edge lab",
  folders: [],
};

describe("Project Twin edge/evidence preview", () => {
  it("renders typed edge provenance and freshness fields without claiming authority", () => {
    render(<ProjectTwinEdgeEvidencePreview project={project} />);

    expect(screen.getByRole("heading", { name: "Edges & evidence" })).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByText(/Canonicality: preview projection/i)).toBeInTheDocument();
    expect(screen.getByText("0 native receipts")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Project Twin preview edges" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Selected Project Twin edge" })).toHaveTextContent(/Source snapshot/i);
    expect(screen.getByText(/Native graph authority.*remain unavailable/i)).toBeInTheDocument();
  });

  it("filters by stale state and shows the stale reason in the selected detail", () => {
    render(<ProjectTwinEdgeEvidencePreview project={project} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Twin edge state filter" }), { target: { value: "stale" } });
    const list = screen.getByRole("list", { name: "Project Twin preview edges" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText(/Generated Twin artifacts may lag/i)).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Selected Project Twin edge" })).getByText("Audit")).toBeInTheDocument();
  });

  it("exports the filtered projection as JSON or Markdown preview", () => {
    render(<ProjectTwinEdgeEvidencePreview project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const region = screen.getByRole("region", { name: "Project Twin edge export preview" });
    expect(within(region).getByRole("code")).toHaveTextContent(/omnia\.project-twin-edge-evidence\.preview\.v1/i);
    fireEvent.change(within(region).getByRole("combobox", { name: "Twin edge export format" }), { target: { value: "markdown" } });
    expect(within(region).getByRole("code")).toHaveTextContent(/Twin edge lab.*Project Twin edge preview/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/Authority: renderer projection/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/Revision: renderer-session-unknown/i);
    expect(within(region).getByRole("code")).toHaveTextContent(/Provenance: Project \/ Chat ownership projection/i);
    expect(within(region).getByText(/does not create a Twin revision/i)).toBeInTheDocument();
  });

  it("keeps inferred edges explicit and exposes selection state to assistive technology", () => {
    render(<ProjectTwinEdgeEvidencePreview project={project} />);

    const list = screen.getByRole("list", { name: "Project Twin preview edges" });
    const inferred = within(list).getByRole("button", { name: /Inferred Project chat preview.*References.*Context manifest preview/i });
    expect(inferred).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(inferred);
    expect(inferred).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("complementary", { name: "Selected Project Twin edge" })).toHaveTextContent(/Inference/i);
  });
});
