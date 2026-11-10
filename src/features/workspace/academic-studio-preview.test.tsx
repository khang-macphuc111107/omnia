import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AcademicStudioPreview from "./academic-studio-preview";

describe("AcademicStudioPreview", () => {
  it("lets a user add an outline section and switch the drafting language", () => {
    render(<AcademicStudioPreview />);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "English" } });
    fireEvent.change(screen.getByLabelText("New outline section"), { target: { value: "Evaluation plan" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    expect(screen.getByText("Evaluation plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /draft/i }));
    expect(screen.getByText("English", { selector: ".academic-studio__draft-meta span" })).toBeInTheDocument();
  });

  it("keeps the citation and export boundaries visible", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /citations/i }));
    expect(screen.getByText(/No URL was fetched/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /export/i }));
    const exportRegion = screen.getByRole("region", { name: /academic draft export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.academic-studio\.preview\.v1/);
  });

  it("supports renderer-local outline history actions", () => {
    render(<AcademicStudioPreview />);
    expect(screen.getByText("1/4 drafted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /mark all drafted/i }));
    expect(screen.getByText("4/4 drafted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo academic draft action/i }));
    expect(screen.getByText("1/4 drafted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /redo academic draft action/i }));
    expect(screen.getByText("4/4 drafted")).toBeInTheDocument();
  });

  it("lets a user add and remove a citation placeholder", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /citations/i }));
    fireEvent.change(screen.getByLabelText("Citation label"), { target: { value: "[4] New paper" } });
    fireEvent.change(screen.getByLabelText("Citation text"), { target: { value: "Author, D. (2026). New paper." } });
    fireEvent.click(screen.getByRole("button", { name: /add citation/i }));
    expect(screen.getByText("[4] New paper")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove \[4\] new paper/i }));
    expect(screen.queryByText("[4] New paper")).not.toBeInTheDocument();
  });

  it("includes citation placeholders in markdown export preview", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /export/i }));
    fireEvent.change(screen.getByLabelText("Academic export format"), { target: { value: "markdown" } });
    const exportRegion = screen.getByRole("region", { name: /academic draft export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Citation review queue/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Omnia harness notes/);
  });

  it("keeps evidence review gates editable and renderer-local", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /review/i }));
    expect(screen.getByText(/Argument review checklist/i)).toBeInTheDocument();
    expect(screen.getByText(/Review status is a writing aid only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /mark all ready/i }));
    expect(screen.getByText("5/5 ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo academic draft action/i }));
    expect(screen.getByText("0/5 ready")).toBeInTheDocument();
  });

  it("imports a renderer-local citation bundle into the review queue", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /citations/i }));
    fireEvent.change(screen.getByLabelText("Citation bundle import"), {
      target: {
        value: JSON.stringify({
          scope: "omnia-academic-citation-bundle-preview",
          version: 1,
          exportedAt: "2026-09-19T00:00:00.000Z",
          title: "Imported study",
          citationStyle: "APA 7",
          citations: [{ id: "imported", label: "[1] Imported source", status: "reviewed in session", text: "Author, Z. (2026). Imported source." }],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /import citations/i }));
    expect(screen.getByText("[1] Imported source")).toBeInTheDocument();
    expect(screen.getByLabelText("Citation style")).toHaveValue("APA 7");
    expect(screen.getByText(/Imported 1 citation entry from JSON/i)).toBeInTheDocument();
  });

  it("supports a renderer-local research plan with completeness cues", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /research plan/i }));
    expect(screen.getByRole("heading", { name: "Research plan" })).toBeInTheDocument();
    expect(screen.getByText("100%", { selector: ".academic-studio__plan-meter strong" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Research method"), { target: { value: "Benchmark" } });
    fireEvent.change(screen.getByLabelText("Hypothesis / expected answer"), { target: { value: "A falsifiable plan." } });
    expect(screen.getByDisplayValue("Benchmark")).toBeInTheDocument();
    expect(screen.getByDisplayValue("A falsifiable plan.")).toBeInTheDocument();
    expect(screen.getByText(/no study was run/i)).toBeInTheDocument();
  });

  it("includes research-plan fields in markdown export", () => {
    render(<AcademicStudioPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /export/i }));
    fireEvent.change(screen.getByLabelText("Academic export format"), { target: { value: "markdown" } });
    const exportRegion = screen.getByRole("region", { name: /academic draft export preview/i });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/## Research plan/);
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/Independent variable/);
  });
});
