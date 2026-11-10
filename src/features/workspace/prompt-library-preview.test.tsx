import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PromptLibraryPreview from "./prompt-library-preview";

describe("Prompt Library preview", () => {
  it("renders seeded templates and the truthful renderer boundary", () => {
    render(<PromptLibraryPreview />);

    expect(screen.getByRole("region", { name: /reusable prompt templates/i })).toBeInTheDocument();
    expect(screen.getByText(/Preview only · Renderer-local/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Meeting brief/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Meeting brief/i })).toBeInTheDocument();
    expect(screen.getByText(/No provider request · No durable write/i)).toBeInTheDocument();
  });

  it("filters templates by search and tag without leaving the renderer surface", () => {
    render(<PromptLibraryPreview />);

    fireEvent.change(screen.getByRole("textbox", { name: /Search prompt templates/i }), { target: { value: "research" } });
    expect(screen.getByRole("button", { name: /Research synthesis/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Meeting brief/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: /Filter template tag/i }), { target: { value: "academic" } });
    expect(screen.getByText(/1 visible/i)).toBeInTheDocument();
  });

  it("supports session-only favorites and saved filter views", () => {
    render(<PromptLibraryPreview />);

    fireEvent.click(screen.getByTitle("Favorite Meeting brief"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show favorite templates only" }));
    expect(screen.getByText(/1 visible/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Meeting brief/i })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /Search prompt templates/i }), { target: { value: "meeting" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Saved prompt view name" }), { target: { value: "My favorites" } });
    fireEvent.click(screen.getByRole("button", { name: /Save view/i }));
    expect(screen.getAllByRole("status").some((node) => /Saved My favorites/i.test(node.textContent ?? ""))).toBe(true);

    const savedViewSelect = screen.getByRole("combobox", { name: "Saved prompt template view" });
    const savedOption = screen.getByRole("option", { name: "My favorites" });
    const savedId = savedOption.getAttribute("value");
    expect(savedId).toBeTruthy();
    fireEvent.change(savedViewSelect, { target: { value: savedId } });
    expect(screen.getAllByRole("status").some((node) => /Applied My favorites/i.test(node.textContent ?? ""))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete saved prompt template view" }));
    expect(screen.getAllByRole("status").some((node) => /Deleted My favorites/i.test(node.textContent ?? ""))).toBe(true);
  });

  it("validates typed values, applies defaults, and resolves the prompt live", () => {
    render(<PromptLibraryPreview />);

    const topic = screen.getByRole("textbox", { name: /Meeting topic/i });
    fireEvent.change(topic, { target: { value: "" } });
    expect(screen.getByText(/Meeting topic is required/i)).toBeInTheDocument();
    expect(screen.getByText(/1 missing/i)).toBeInTheDocument();

    fireEvent.change(topic, { target: { value: "Q4 readiness" } });
    expect(screen.getByText(/All required values are valid/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/updated in this preview/i);
    expect(screen.getByText(/Q4 readiness/)).toBeInTheDocument();
  });

  it("loads an example and keeps the resolved prompt scoped to the selected template", () => {
    render(<PromptLibraryPreview />);

    fireEvent.click(screen.getByRole("button", { name: /Quarterly planning/i }));
    expect(screen.getByRole("textbox", { name: /Meeting topic/i })).toHaveValue("Q4 launch readiness");
    expect(screen.getByRole("combobox", { name: /Audience/i })).toHaveValue("leadership");
    expect(screen.getByText(/Loaded example Quarterly planning/i)).toBeInTheDocument();
    expect(screen.getByText(/Q4 launch readiness/)).toBeInTheDocument();
  });

  it("shows session-only version history and portable export preview", () => {
    render(<PromptLibraryPreview />);

    fireEvent.click(screen.getByRole("button", { name: /Capture version/i }));
    expect(screen.getByText(/Created preview version 1\.2\.1/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Preview export/i }));
    const exportRegion = screen.getByRole("region", { name: /Prompt template export preview/i });
    expect(exportRegion).toHaveTextContent(/omnia\.prompt-template\.preview\.v1/i);

    fireEvent.change(screen.getByRole("combobox", { name: /Format/i }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByText(/# Meeting brief/i)).toBeInTheDocument();
    expect(within(exportRegion).getByText(/No native version receipt/i)).toBeInTheDocument();
  });

  it("lets the user inspect a history record and stage a non-mutating rollback preview", () => {
    render(<PromptLibraryPreview />);

    const history = screen.getByRole("region", { name: /Prompt template version history/i });
    fireEvent.click(within(history).getByRole("button", { name: /v1\.2\.0/i }));
    expect(screen.getByRole("region", { name: /Prompt template version inspector/i })).toHaveTextContent(/v1\.2\.0 compared with v1\.2\.0/i);
    expect(screen.getByText(/No body or variable-set differences/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview rollback/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Capture version/i }));
    expect(screen.getByText(/Created preview version 1\.2\.1/i)).toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button", { name: /v1\.2\.0/i }));
    fireEvent.click(screen.getByRole("button", { name: /Preview rollback/i }));
    expect(screen.getByText(/Rollback to v1\.2\.0 is staged as a renderer preview only/i)).toBeInTheDocument();
    expect(screen.getByText(/current template remains v1\.2\.1/i)).toBeInTheDocument();
  });

  it("creates, clones, and archives only renderer-local template records", () => {
    render(<PromptLibraryPreview />);

    fireEvent.click(screen.getByRole("button", { name: /New template/i }));
    expect(screen.getByRole("heading", { name: /Untitled prompt template/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clone/i }));
    expect(screen.getByRole("heading", { name: /Untitled prompt template copy/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Archive/i }));
    expect(screen.getByText(/Archived Untitled prompt template copy in this preview/i)).toBeInTheDocument();
    expect(screen.getByText(/Changes stay in this renderer session/i)).toBeInTheDocument();
  });

  it("organizes templates by renderer-local folders", () => {
    render(<PromptLibraryPreview />);

    const catalog = screen.getByRole("complementary", { name: /Prompt templates/i });
    expect(within(catalog).getByRole("button", { name: /Meeting brief/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Engineering 1$/i }));
    expect(within(catalog).getByRole("button", { name: /Evidence-first code review/i })).toBeInTheDocument();
    expect(within(catalog).queryByRole("button", { name: /Meeting brief/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open organizer/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /New prompt folder name/i }), { target: { value: "Research Ops" } });
    fireEvent.click(screen.getByRole("button", { name: /Create folder/i }));
    expect(screen.getAllByRole("status").some((node) => /Created Research Ops/i.test(node.textContent ?? ""))).toBe(true);

    fireEvent.change(screen.getByRole("combobox", { name: /Selected template folder/i }), { target: { value: "Research Ops" } });
    expect(screen.getAllByRole("status").some((node) => /Meeting brief moved to Research Ops/i.test(node.textContent ?? ""))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Research Ops 1$/i }));
    expect(within(catalog).getByRole("button", { name: /Meeting brief/i })).toBeInTheDocument();
  });

  it("supports session-only tag editing on the selected template", () => {
    render(<PromptLibraryPreview />);

    const tagInput = screen.getByRole("textbox", { name: /Add tag to selected template/i });
    fireEvent.change(tagInput, { target: { value: "ui polish" } });
    fireEvent.click(screen.getByRole("button", { name: /Add tag/i }));
    expect(screen.getByRole("button", { name: /Remove tag ui-polish/i })).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((node) => /Added #ui-polish/i.test(node.textContent ?? ""))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Remove tag ui-polish/i }));
    expect(screen.queryByRole("button", { name: /Remove tag ui-polish/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").some((node) => /Removed #ui-polish/i.test(node.textContent ?? ""))).toBe(true);
  });

  it("keeps folder scope inside saved prompt views", () => {
    render(<PromptLibraryPreview />);

    fireEvent.change(screen.getByRole("combobox", { name: /Filter template folder/i }), { target: { value: "Engineering" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Saved prompt view name" }), { target: { value: "Engineering prompts" } });
    fireEvent.click(screen.getByRole("button", { name: /Save view/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /Filter template folder/i }), { target: { value: "all" } });

    const savedOption = screen.getByRole("option", { name: "Engineering prompts" });
    fireEvent.change(screen.getByRole("combobox", { name: "Saved prompt template view" }), { target: { value: savedOption.getAttribute("value") } });
    expect(screen.getByRole("combobox", { name: /Filter template folder/i })).toHaveValue("Engineering");
    expect(screen.getAllByRole("status").some((node) => /Applied Engineering prompts/i.test(node.textContent ?? ""))).toBe(true);
  });
});
