import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import SkillsScreen from "./activities/skills-screen";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Skills Studio preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("shows catalog metadata and keeps preview toggles local to the renderer", () => {
    render(<SkillsScreen />);

    expect(screen.getByRole("heading", { name: "Skills Studio" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Catalog" })).toHaveAttribute("aria-selected", "true");
    const catalogList = screen.getByRole("list", { name: "catalog skills" });
    expect(within(catalogList).getByText("Grounded research")).toBeInTheDocument();
    expect(screen.queryByText("Requested permissions across the catalog")).not.toBeInTheDocument();

    fireEvent.click(within(catalogList).getByText("Schema guardian").closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    expect(within(detail).getByText(/Validate generated JSON/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: /enable in preview/i }));
    expect(within(detail).getByRole("button", { name: /disable in preview/i })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().skills.find((skill) => skill.id === "skill-structured-output")?.enabled).toBe(false);
  });

  it("exposes permissions and loading boundary tabs", () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    expect(screen.getByRole("heading", { name: /requested permissions/i })).toBeInTheDocument();
    expect(screen.getByText(/Native permission prompts and audit receipts are planned/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Loading" }));
    expect(screen.getByRole("heading", { name: /progressive loading plan/i })).toBeInTheDocument();
    expect(screen.getByText(/not connected to the native bridge/i)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across studio tabs", () => {
    render(<SkillsScreen />);

    const catalog = screen.getByRole("tab", { name: "Catalog" });
    fireEvent.keyDown(catalog, { key: "ArrowRight" });

    const installed = screen.getByRole("tab", { name: "Installed" });
    expect(installed).toHaveAttribute("aria-selected", "true");
    expect(installed).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "skill-studio-tab-installed");
  });

  it("keeps skill activation changes reversible inside the renderer preview", () => {
    render(<SkillsScreen />);

    const catalogList = screen.getByRole("list", { name: "catalog skills" });
    fireEvent.click(within(catalogList).getByText("Schema guardian").closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    fireEvent.click(within(detail).getByRole("button", { name: /enable in preview/i }));
    expect(within(detail).getByRole("button", { name: /disable in preview/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo skill activation preview change" }));
    expect(within(detail).getByRole("button", { name: /enable in preview/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Redo skill activation preview change" }));
    expect(within(detail).getByRole("button", { name: /disable in preview/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset skill activation preview" }));
    expect(within(detail).getByRole("button", { name: /enable in preview/i })).toBeInTheDocument();
    expect(screen.getByText(/Toggle changes exist only in this renderer session/i)).toBeInTheDocument();
  });

  it("requires an explicit review before an unreviewed skill can be enabled", () => {
    useWorkspaceStore.setState({
      skills: initialState.skills.map((skill) => skill.id === "skill-structured-output"
        ? { ...skill, trust: "Unreviewed", enabled: false }
        : skill),
    });
    render(<SkillsScreen />);

    const catalogList = screen.getByRole("list", { name: "catalog skills" });
    fireEvent.click(within(catalogList).getByText("Schema guardian").closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected skill details" });

    fireEvent.click(within(detail).getByRole("button", { name: /enable in preview/i }));
    expect(within(detail).getByRole("button", { name: /enable in preview/i })).toBeInTheDocument();
    expect(screen.getByText(/needs an explicit review before it can be enabled/i)).toBeInTheDocument();

    fireEvent.click(within(detail).getByRole("button", { name: /review in preview/i }));
    fireEvent.click(within(detail).getByRole("button", { name: /enable in preview/i }));
    expect(within(detail).getByRole("button", { name: /disable in preview/i })).toBeInTheDocument();
    expect(within(detail).getByText(/native trust and installation remain unchanged/i)).toBeInTheDocument();
    expect(useWorkspaceStore.getState().skills.find((skill) => skill.id === "skill-structured-output")?.enabled).toBe(false);
  });

  it("offers an exact-package activation checklist with a renderer-only review marker", () => {
    useWorkspaceStore.setState({
      skills: initialState.skills.map((skill) => skill.id === "skill-structured-output"
        ? { ...skill, trust: "Unreviewed", enabled: false }
        : skill),
    });
    render(<SkillsScreen />);

    const catalogList = screen.getByRole("list", { name: "catalog skills" });
    fireEvent.click(within(catalogList).getByText("Schema guardian").closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Review checklist" }));

    const review = within(detail).getByRole("region", { name: "Skill activation review checklist" });
    expect(review).toHaveTextContent("0/4 checked");
    const checks = within(review).getAllByRole("checkbox");
    expect(checks).toHaveLength(4);
    fireEvent.click(checks[0]!);
    expect(review).toHaveTextContent("1/4 checked");
    expect(within(detail).getByRole("button", { name: /enable in preview/i })).toBeInTheDocument();

    checks.slice(1).forEach((checkbox) => fireEvent.click(checkbox));
    expect(review).toHaveTextContent("4/4 checked");
    fireEvent.click(within(detail).getByRole("button", { name: /enable in preview/i }));
    expect(within(detail).getByRole("button", { name: /disable in preview/i })).toBeInTheDocument();
    expect(within(review).getByText(/native trust/i)).toBeInTheDocument();
  });

  it("previews an enabled skill manifest without implying installation or provider injection", () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const preview = screen.getByRole("region", { name: "Skill stack manifest preview" });
    expect(preview).toHaveTextContent(/renderer-local manifest/i);
    expect(within(preview).getByRole("combobox", { name: "Skill manifest format" })).toHaveValue("json");
    expect(within(preview).getByRole("code")).toHaveTextContent(/omnia\.skill-stack-preview\.v1/i);

    fireEvent.change(within(preview).getByRole("combobox", { name: "Skill manifest format" }), { target: { value: "markdown" } });
    expect(within(preview).getByRole("code")).toHaveTextContent(/# Omnia skill stack preview/i);
    expect(within(preview).getByText(/does not install, load, authorize, or inject/i)).toBeInTheDocument();
  });

  it("exposes inspectable skill detail tabs with truthful renderer boundaries", () => {
    render(<SkillsScreen />);

    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    fireEvent.click(within(detail).getByRole("tab", { name: "Instructions" }));
    expect(within(detail).getByRole("region")).toHaveTextContent(/Instruction package/i);
    expect(within(detail).getByText(/not injected into a provider request/i)).toBeInTheDocument();

    fireEvent.click(within(detail).getByRole("tab", { name: "Tests" }));
    expect(within(detail).getByText(/Provider smoke test/i)).toBeInTheDocument();
    expect(within(detail).getByText(/native dispatch unavailable/i)).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across selected-skill detail tabs", () => {
    render(<SkillsScreen />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const instructions = screen.getByRole("tab", { name: "Instructions" });
    expect(instructions).toHaveAttribute("aria-selected", "true");
    expect(instructions).toHaveFocus();
  });

  it("previews a renderer-local version diff with selectable baseline and current revisions", () => {
    render(<SkillsScreen />);

    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    fireEvent.click(within(detail).getByRole("tab", { name: "Versions" }));

    expect(within(detail).getByText(/Compare renderer revisions/i)).toBeInTheDocument();
    expect(within(detail).getByRole("combobox", { name: "Skill version baseline" })).toHaveValue("skill-deep-research:initial");
    expect(within(detail).getByRole("combobox", { name: "Skill version current" })).toHaveValue("skill-deep-research:current");
    expect(within(detail).getByText(/changed field/i)).toBeInTheDocument();
    expect(within(detail).getByRole("list", { name: "Skill version field differences" })).toHaveTextContent(/Permissions/);
    expect(within(detail).getByText(/does not install, rollback, write version provenance/i)).toBeInTheDocument();

    fireEvent.change(within(detail).getByRole("combobox", { name: "Skill version baseline" }), { target: { value: "skill-deep-research:current" } });
    expect(within(detail).getByText(/0 changed fields/i)).toBeInTheDocument();
    expect(within(detail).getAllByText(/Same/i).length).toBeGreaterThan(0);
  });

  it("compares two catalog skills side by side without changing catalog state", () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Add Grounded research to comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Schema guardian to comparison" }));

    const comparison = screen.getByRole("region", { name: "Skill catalog comparison" });
    expect(within(comparison).getByText("7 changed fields")).toBeInTheDocument();
    expect(within(comparison).getByRole("table")).toHaveTextContent("Grounded research");
    expect(within(comparison).getByRole("table")).toHaveTextContent("Schema guardian");
    expect(within(comparison).getByRole("table")).toHaveTextContent("Requested permissions");
    expect(within(comparison).getByText(/does not execute either skill/i)).toBeInTheDocument();
    expect(useWorkspaceStore.getState().skills).toEqual(initialState.skills);

    fireEvent.click(within(comparison).getByRole("button", { name: "Clear selection" }));
    expect(within(comparison).getByText(/choose two skills below/i)).toBeInTheDocument();
  });

  it("keeps skill comparison limited to two entries", () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Add Grounded research to comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Schema guardian to comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Product spec critic to comparison" }));

    expect(screen.getByRole("status", { name: "Skills summary" })).toBeInTheDocument();
    expect(screen.getByText(/comparison holds two skills/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Product spec critic to comparison" })).toHaveAttribute("aria-pressed", "false");
  });
});
