import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocalModelReadinessPreview } from "./local-model-readiness-preview";

describe("LocalModelReadinessPreview", () => {
  it("shows the audited host posture without claiming a native probe", () => {
    render(<LocalModelReadinessPreview />);

    expect(screen.getByRole("heading", { name: "Local Model Readiness" })).toBeInTheDocument();
    expect(screen.getByText("2026-08-14")).toBeInTheDocument();
    expect(screen.getByText(/Historical host snapshot/i)).toBeInTheDocument();
    expect(screen.getAllByText("Not observed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/does not inspect the filesystem/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Frontier cloud replacement" })).toBeInTheDocument();
  });

  it("keeps planning controls local and updates the redacted preview payload", () => {
    render(<LocalModelReadinessPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: "Planning role" }), {
      target: { value: "retrieval" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Candidate storage root" }), {
      target: { value: "C: system volume" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Require hybrid fallback" }));

    expect(screen.getByRole("status")).toHaveTextContent(/Audit snapshot loaded/i);
    expect(screen.getByText("Embedding and reranking", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Candidate storage root" })).toHaveValue("C: system volume");
    expect(screen.getByRole("checkbox", { name: "Require hybrid fallback" })).not.toBeChecked();
    expect(screen.getByLabelText("Local model readiness JSON preview")).toHaveTextContent("Embedding and reranking");
    expect(screen.getByLabelText("Local model readiness JSON preview")).toHaveTextContent("C: system volume");
  });

  it("refreshes the renderer projection and exposes export controls", () => {
    render(<LocalModelReadinessPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Renderer preview refreshed at/i);
    expect(screen.getByRole("button", { name: "Copy readiness brief" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeInTheDocument();
    expect(screen.getByText(/no filesystem authority/i)).toBeInTheDocument();
  });
});
