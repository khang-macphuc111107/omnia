import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import SkillsScreen from "./activities/skills-screen";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Skill activation matrix preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("shows project-scoped activation cells and a truthful renderer boundary", () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Project matrix" }));
    const matrix = screen.getByRole("region", { name: "Per-project skill activation matrix" });
    expect(matrix).toHaveTextContent(/activation by project/i);
    expect(matrix).toHaveTextContent(/renderer-local/i);
    expect(within(matrix).getAllByRole("columnheader").length).toBeGreaterThan(2);
    expect(within(matrix).getByRole("button", { name: /inspect schema guardian/i })).toBeInTheDocument();
  });

  it("toggles project activation without mutating the store skill record", () => {
    const before = useWorkspaceStore.getState().skills;
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Project matrix" }));
    const matrix = screen.getByRole("region", { name: "Per-project skill activation matrix" });
    const projectToggle = within(matrix).getAllByRole("button", { name: /toggle .* for /i })[0]!;
    expect(projectToggle).toBeInTheDocument();
    fireEvent.click(projectToggle);
    expect(useWorkspaceStore.getState().skills).toBe(before);
  });

  it("compares project drafts and previews an export without leaving renderer-local scope", () => {
    render(<SkillsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Project matrix" }));
    const matrix = screen.getByRole("region", { name: "Per-project skill activation matrix" });
    const compare = within(matrix).getByRole("region", { name: "Project activation diff preview" });

    expect(within(compare).getByRole("combobox", { name: "Compare project activation with" })).toBeInTheDocument();
    expect(within(compare).getByRole("combobox", { name: "Project activation diff format" })).toHaveValue("json");
    expect(within(compare).getByText(/renderer-local/i)).toBeInTheDocument();

    fireEvent.click(within(compare).getByText(/inspect json diff payload/i));
    expect(compare).toHaveTextContent("omnia.skill-project-activation-diff-preview.v1");

    fireEvent.change(within(compare).getByRole("combobox", { name: "Project activation diff format" }), { target: { value: "markdown" } });
    expect(within(compare).getByText(/inspect markdown diff payload/i)).toBeInTheDocument();
  });
});
