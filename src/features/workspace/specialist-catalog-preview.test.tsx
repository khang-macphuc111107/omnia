import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SpecialistCatalogPreview from "./specialist-catalog-preview";
import SkillsScreen from "./activities/skills-screen";

describe("Specialist catalog explorer preview", () => {
  it("shows role contracts, boundaries, and a reversible shortlist", () => {
    render(<SpecialistCatalogPreview />);

    expect(screen.getByRole("heading", { name: "Explore roles and personas" })).toBeInTheDocument();
    expect(screen.getAllByText("Goal Architect").length).toBeGreaterThan(0);
    expect(screen.getByText(/Roles define bounded operational contracts/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add Goal Architect shortlist/i }));
    expect(screen.getByText("1 shortlisted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Shortlisted/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
    const preview = screen.getByRole("region", { name: "Specialist selection preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent(/omnia\.specialist-selection-preview\.v1/);
    expect(preview).toHaveTextContent(/Native profile resolution.*planned/i);
  });

  it("switches to personas and filters the catalog without implying authority", () => {
    render(<SpecialistCatalogPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Persona packs/i }));
    expect(screen.getAllByText("Evidence-first").length).toBeGreaterThan(0);
    expect(screen.getByText("None granted")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Specialist evidence" }), { target: { value: "planned" } });
    expect(screen.getByText("No catalog entries match")).toBeInTheDocument();
    expect(screen.getByText(/does not grant tools, secrets, permissions/i)).toBeInTheDocument();
  });

  it("supports search and markdown export for a mixed shortlist", () => {
    render(<SpecialistCatalogPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Search specialist catalog" }), { target: { value: "rust" } });
    expect(screen.getByText("Production Rust Engineer")).toBeInTheDocument();
    const roleList = screen.getByRole("list", { name: "Specialist role profiles" });
    expect(within(roleList).queryByText("Goal Architect")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add Production Rust Engineer shortlist/i }));
    fireEvent.click(screen.getByRole("tab", { name: /Persona packs/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add Evidence-first shortlist/i }));
    fireEvent.click(screen.getByRole("button", { name: "Preview selection" }));
    const preview = screen.getByRole("region", { name: "Specialist selection preview" });
    fireEvent.change(within(preview).getByRole("combobox", { name: "Specialist selection format" }), { target: { value: "markdown" } });
    expect(within(preview).getByRole("code")).toHaveTextContent(/# Omnia specialist selection preview/);
    expect(within(preview).getByRole("code")).toHaveTextContent(/Production Rust Engineer/);
    expect(within(preview).getByText(/Native profile resolution, child ceilings, grants, receipts/i)).toBeInTheDocument();
  });

  it("is reachable from Skills Studio without changing the existing default catalog view", async () => {
    render(<SkillsScreen />);

    expect(screen.getByRole("tab", { name: "Catalog" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Specialists" }));
    expect(await screen.findByRole("heading", { name: "Explore roles and personas" })).toBeInTheDocument();
    expect(screen.getByText(/Roles define bounded operational contracts; personas shape presentation only/i)).toBeInTheDocument();
  });
});
