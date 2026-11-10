import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PromptTemplateLabPreview from "./prompt-template-lab-preview";

describe("Prompt Template Lab preview", () => {
  it("rehearses a complete example and reports validation-only output", () => {
    render(<PromptTemplateLabPreview />);

    expect(screen.getByRole("heading", { name: "Prompt Template Lab" })).toBeInTheDocument();
    expect(screen.getByText(/No provider request · No model-quality claim · No durable write/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check selected/i }));

    expect(screen.getByText(/Case checks passed/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Resolved example result")).toHaveTextContent("Review this typescript excerpt");
  });

  it("surfaces missing and invalid inputs and clears stale results after edits", () => {
    render(<PromptTemplateLabPreview />);

    fireEvent.click(screen.getByRole("button", { name: /Missing code excerpt/i }));
    fireEvent.click(screen.getByRole("button", { name: /Check selected/i }));
    expect(screen.getByText(/Code excerpt is required/i)).toBeInTheDocument();
    expect(screen.getByText(/Review this case/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Unsupported language value/i }));
    fireEvent.click(screen.getByRole("button", { name: /Check selected/i }));
    expect(screen.getByText(/Language is not a listed choice/i)).toBeInTheDocument();

    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "rust" } });
    expect(screen.queryByText(/Language is not a listed choice/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Run a case to inspect its deterministic validation/i)).toBeInTheDocument();
  });

  it("adds, duplicates, removes, and resets renderer-local example cases", () => {
    render(<PromptTemplateLabPreview />);

    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    expect(screen.getByLabelText("Case name")).toHaveValue("Untitled example");
    fireEvent.change(screen.getByLabelText("Case name"), { target: { value: "My custom sample" } });
    fireEvent.click(screen.getByRole("button", { name: /Duplicate/i }));
    expect(screen.getByLabelText("Case name")).toHaveValue("My custom sample copy");
    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    expect(screen.queryByRole("button", { name: /My custom sample copy/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reset examples/i }));
    expect(screen.getByRole("button", { name: /Complete TypeScript sample/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /My custom sample/i })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Example cases")).getAllByRole("button", { name: /Complete TypeScript sample|Missing code excerpt|Unsupported language value/i })).toHaveLength(3);
  });

  it("switches between seeded template labs and shows their typed-variable coverage", () => {
    render(<PromptTemplateLabPreview />);

    fireEvent.change(screen.getByLabelText("Template sample"), { target: { value: "lab-research-synthesis" } });
    expect(screen.getByRole("button", { name: /Evidence map/i })).toBeInTheDocument();
    expect(screen.getAllByText("Research question").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2/2").length).toBeGreaterThan(0);
  });
});
