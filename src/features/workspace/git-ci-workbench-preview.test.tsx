import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GitCiWorkbenchPreview } from "./git-ci-workbench-preview";

describe("Git and CI/CD workbench preview", () => {
  it("shows delivery tabs and keeps Git/CI actions preview-only", () => {
    render(<GitCiWorkbenchPreview projectName="Omnia" />);

    expect(screen.getByRole("heading", { name: "Git & CI/CD workbench" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "Synthetic working tree changes" })).toBeInTheDocument();
    expect(screen.getByText(/no repository was read/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));
    expect(screen.getByRole("listbox", { name: "Preview branches" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Pipelines" }));
    expect(screen.getByRole("listbox", { name: "Preview pipelines" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Release" }));
    expect(screen.getByRole("button", { name: "Deploy release planned" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy release planned" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Release evidence matrix" })).toHaveTextContent(/Candidate readiness map/);
    expect(screen.getByRole("region", { name: "Release evidence matrix" })).toHaveTextContent(/Ready/);
    expect(screen.getByRole("region", { name: "Release evidence matrix" })).toHaveTextContent(/Planned/);
  });

  it("supports staging, branch, pipeline, release, and export rehearsals", async () => {
    render(<GitCiWorkbenchPreview projectName="Omnia" />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Stage src\/features\/workspace\/project-ide-preview\.tsx/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/staged in preview/i);

    fireEvent.click(screen.getByRole("tab", { name: "Branches" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New branch name" }), { target: { value: "preview/feature/release" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/no native branch was created/i);
    expect(within(screen.getByRole("listbox", { name: "Preview branches" })).getByRole("option", { name: /preview\/feature\/release/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Pipelines" }));
    fireEvent.click(screen.getByRole("button", { name: "Run CI preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/no CI request was sent/i);

    fireEvent.click(screen.getByRole("tab", { name: "Release" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare release preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/deployment remains Planned/i);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportPanel = screen.getByRole("region", { name: "Git and CI export preview" });
    expect(within(exportPanel).getByText(/omnia\.git-ci-workbench-preview\.v1/i)).toBeInTheDocument();
    expect(within(exportPanel).getByText(/releaseEvidence/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    const history = screen.getByRole("list", { name: "Delivery activity events" });
    expect(within(history).getByText(/Prepared release handoff/i)).toBeInTheDocument();
    expect(within(history).getByText(/Started CI rehearsal/i)).toBeInTheDocument();
  });

  it("filters and resets the renderer-local delivery activity ledger", () => {
    render(<GitCiWorkbenchPreview projectName="Omnia" />);

    fireEvent.click(screen.getByRole("tab", { name: "Pipelines" }));
    fireEvent.click(screen.getByRole("button", { name: "Run CI preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    fireEvent.change(screen.getByRole("combobox", { name: "Filter delivery activity" }), { target: { value: "pipeline" } });
    expect(screen.getByText(/Started CI rehearsal/i)).toBeInTheDocument();
    expect(screen.queryByText(/Synthetic delivery snapshot loaded/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset activity" }));
    expect(screen.getByText(/Synthetic delivery snapshot loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Started CI rehearsal/i)).not.toBeInTheDocument();
  });

  it("supports session-only custom release gates and includes them in export preview", () => {
    render(<GitCiWorkbenchPreview projectName="Omnia" />);

    fireEvent.click(screen.getByRole("tab", { name: "Release" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom checklist label" }), { target: { value: "Verify migration rehearsal" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Custom checklist detail" }), { target: { value: "Confirm the rollback drill is documented" } });
    fireEvent.click(screen.getByRole("button", { name: "Add custom gate" }));

    expect(screen.getByText("Verify migration rehearsal")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Custom checklist: Verify migration rehearsal" }));
    expect(screen.getByRole("status")).toHaveTextContent(/checked in release preview/i);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const exportPanel = screen.getByRole("region", { name: "Git and CI export preview" });
    expect(within(exportPanel).getByText(/customChecklist/i)).toBeInTheDocument();
    expect(within(exportPanel).getByText(/Verify migration rehearsal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset checklist" }));
    expect(screen.queryByText("Verify migration rehearsal")).not.toBeInTheDocument();
    expect(screen.getByText(/No custom gates yet/i)).toBeInTheDocument();
  });
});
