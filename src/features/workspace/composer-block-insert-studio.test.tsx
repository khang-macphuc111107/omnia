import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  COMPOSER_BLOCK_TEMPLATES,
  ComposerBlockInsertStudio,
} from "./composer-block-insert-studio";

describe("ComposerBlockInsertStudio", () => {
  it("offers a broad block catalog with honest renderer-only boundary", () => {
    expect(COMPOSER_BLOCK_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(COMPOSER_BLOCK_TEMPLATES.map((template) => template.category))).toEqual(
      new Set(["Structure", "Code", "Data", "Math", "Layout"]),
    );

    render(<ComposerBlockInsertStudio onInsert={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Block insert studio" })).toBeInTheDocument();
    expect(screen.getByText(/no file read, provider call, code execution, or durable write/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Mermaid diagram/i })).toBeInTheDocument();
  });

  it("filters categories, previews a template, and inserts the selected snippet", () => {
    const onInsert = vi.fn();
    render(<ComposerBlockInsertStudio onInsert={onInsert} />);

    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    expect(screen.getByRole("option", { name: /LaTeX equation/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Table/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Insert block/i }));
    expect(onInsert).toHaveBeenCalledWith(expect.stringContaining("\\frac"));

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search block templates" }), { target: { value: "json" } });
    expect(screen.getByRole("option", { name: /JSON object/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Mermaid diagram/i })).not.toBeInTheDocument();
  });

  it("lets the user customize, reset, clear, and insert a renderer-local draft", () => {
    const onInsert = vi.fn();
    render(<ComposerBlockInsertStudio onInsert={onInsert} />);

    const draft = screen.getByRole("textbox", { name: "Edit block snippet" });
    expect(draft).toHaveValue("## Section title");

    fireEvent.change(draft, { target: { value: "## Ship it\n\n- [ ] Verify preview" } });
    expect(screen.getByRole("status")).toHaveTextContent(/Custom draft/);
    fireEvent.click(screen.getByRole("button", { name: /Insert block/i }));
    expect(onInsert).toHaveBeenCalledWith("## Ship it\n\n- [ ] Verify preview");

    fireEvent.change(draft, { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: /Reset starter/i }));
    expect(draft).toHaveValue("## Section title");

    fireEvent.click(screen.getByRole("button", { name: /Clear draft/i }));
    expect(draft).toHaveValue("");
    expect(screen.getByRole("button", { name: /Insert block/i })).toBeDisabled();
  });
});
