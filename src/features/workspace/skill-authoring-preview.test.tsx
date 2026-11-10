import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SkillAuthoringPreview, { normalizeDraft, serializeSkillDraft, starterDraft } from "./skill-authoring-preview";
import SkillsScreen from "./activities/skills-screen";

describe("Skill authoring preview", () => {
  it("keeps imported icon metadata out of inspector chrome without changing the manifest", () => {
    const { container } = render(<SkillAuthoringPreview initialDraft={{ icon: "🚀" }} />);

    const mark = container.querySelector(".skill-authoring__mark");
    expect(mark?.textContent).toBe("");
    expect(mark?.querySelector("svg")).toHaveAttribute("stroke", "currentColor");
    expect(mark?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(mark?.querySelector("svg")).toHaveAttribute("width", "16");

    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const preview = screen.getByRole("region", { name: "Skill authoring manifest preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent('"icon": "🚀"');
  });

  it("opens from Skills Studio and exposes a reversible, renderer-local authoring surface", async () => {
    render(<SkillsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    const authoring = screen.getByRole("region", { name: "Skill authoring workspace" });
    expect(await within(authoring).findByRole("heading", { name: /shape an instruction package/i })).toBeInTheDocument();
    expect(within(authoring).getByText("Renderer-local")).toBeInTheDocument();
    expect(within(authoring).getByRole("button", { name: /save to catalog planned/i })).toBeDisabled();

    fireEvent.change(within(authoring).getByRole("combobox", { name: "Skill starter template" }), { target: { value: "cse-coach" } });
    fireEvent.click(within(authoring).getByRole("button", { name: "Apply starter" }));
    expect(within(authoring).getByRole("textbox", { name: "Skill draft name" })).toHaveValue("CSE problem-solving coach");

    fireEvent.click(within(authoring).getByRole("button", { name: "Undo skill draft edit" }));
    expect(within(authoring).getByRole("textbox", { name: "Skill draft name" })).toHaveValue("New skill draft");
    fireEvent.click(within(authoring).getByRole("button", { name: "Redo skill draft edit" }));
    expect(within(authoring).getByRole("textbox", { name: "Skill draft name" })).toHaveValue("CSE problem-solving coach");
    fireEvent.click(within(authoring).getByRole("button", { name: "Preview manifest" }));
    expect(within(authoring).getByText(/does not install, load, authorize, persist, or inject/i)).toBeInTheDocument();
  });

  it("edits metadata, previews a manifest, and keeps native installation planned", () => {
    render(<SkillAuthoringPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: "Skill draft name" }), { target: { value: "Proof lab" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Skill draft permissions" }), { target: { value: "read notes, use citations" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const preview = screen.getByRole("region", { name: "Skill authoring manifest preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent(/omnia\.skill-authoring-preview\.v1/);
    expect(within(preview).getByRole("code")).toHaveTextContent(/Proof lab/);

    fireEvent.change(within(preview).getByRole("combobox", { name: "Skill authoring manifest format" }), { target: { value: "markdown" } });
    expect(within(preview).getByRole("code")).toHaveTextContent(/# Proof lab/);
    expect(screen.getByText(/native install/i)).toBeInTheDocument();
  });

  it("opens a selected catalog skill in an editable renderer draft and stages the projection locally", async () => {
    const original = "Grounded research";
    render(<SkillsScreen />);

    const catalogList = screen.getByRole("list", { name: "catalog skills" });
    fireEvent.click(within(catalogList).getByText(original).closest("button")!);
    const detail = screen.getByRole("complementary", { name: "Selected skill details" });
    fireEvent.click(within(detail).getByRole("button", { name: "Edit in preview" }));

    const authoring = screen.getByRole("region", { name: "Skill authoring workspace" });
    expect(await within(authoring).findByRole("textbox", { name: "Skill draft name" })).toHaveValue(original);
    expect(await within(authoring).findByRole("button", { name: "Stage in preview" })).not.toBeDisabled();

    fireEvent.change(within(authoring).getByRole("textbox", { name: "Skill draft name" }), { target: { value: "Grounded research — edited" } });
    fireEvent.click(within(authoring).getByRole("button", { name: "Stage in preview" }));

    expect(within(screen.getByRole("list", { name: "catalog skills" })).getByText("Grounded research — edited")).toBeInTheDocument();
    expect(screen.getByText(/native catalog is unchanged/i)).toBeInTheDocument();
  });

  it("normalizes a safe draft payload and serializes both supported formats", () => {
    const normalized = normalizeDraft({ ...starterDraft, id: "skill-imported", name: "Imported skill", scope: "bad", permissions: ["read"], extra: "ignored" });
    expect(normalized).toMatchObject({ id: "skill-imported", name: "Imported skill", scope: "Manual", permissions: ["read"] });
    expect(normalized).not.toHaveProperty("extra");
    expect(serializeSkillDraft(normalized!, "json")).toContain("omnia.skill-authoring-preview.v1");
    expect(serializeSkillDraft(normalized!, "markdown")).toContain("# Imported skill");
    expect(normalizeDraft({ id: "", name: "" })).toBeNull();
  });

  it("authors bounded evaluation cases and carries them into the manifest without executing them", () => {
    render(<SkillAuthoringPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    expect(screen.getByRole("region", { name: "Skill authoring preview" })).toHaveTextContent(/not been executed/i);
    expect(screen.getByText("Evaluation cases")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Evaluation case 1 title" }), { target: { value: "Check empty input" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Evaluation case 1 input" }), { target: { value: "A caller supplies an empty list to the skill." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Evaluation case 1 expected behavior" }), { target: { value: "Explain the guard and avoid claiming that the case was executed." } });
    const inspector = screen.getByRole("complementary", { name: "Skill authoring inspector" });
    expect(within(within(inspector).getByText("Evaluation cases").parentElement!).getByText("Ready")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview manifest" }));
    const preview = screen.getByRole("region", { name: "Skill authoring manifest preview" });
    expect(within(preview).getByRole("code")).toHaveTextContent(/evaluationCases/);
    expect(within(preview).getByRole("code")).toHaveTextContent(/Check empty input/);

    fireEvent.click(screen.getByRole("button", { name: "Remove evaluation case 1" }));
    expect(screen.getByText(/No scenarios yet/)).toBeInTheDocument();
  });
});
