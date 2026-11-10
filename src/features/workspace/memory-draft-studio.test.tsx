import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import MemoryDraftStudio, { parseMemoryDraftPayload } from "./memory-draft-studio";

describe("MemoryDraftStudio", () => {
  it("validates, edits, and stages a renderer-local memory draft", () => {
    const onStage = vi.fn();
    render(<MemoryDraftStudio onClose={vi.fn()} onStage={onStage} existingScopes={["Global", "Omnia project"]} />);

    const stage = screen.getByRole("button", { name: /stage in preview/i });
    expect(stage).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Memory content" }), {
      target: { value: "Prefer compact implementation reports" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Memory scope" }), { target: { value: "Omnia project" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Memory source label" }), { target: { value: "Manual note" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Memory confidence" }), { target: { value: "0.9" } });

    expect(stage).not.toBeDisabled();
    expect(screen.getByRole("complementary", { name: "Memory draft live preview" })).toHaveTextContent(/Prefer compact implementation reports/i);

    fireEvent.click(stage);
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({
      content: "Prefer compact implementation reports",
      scopeLabel: "Omnia project",
      confidence: 0.9,
    }), null);
  });

  it("keeps undo, redo, reset, and portable export inside the preview boundary", () => {
    const onStage = vi.fn();
    render(<MemoryDraftStudio onClose={vi.fn()} onStage={onStage} />);

    const content = screen.getByRole("textbox", { name: "Memory content" });
    fireEvent.change(content, { target: { value: "First draft" } });
    fireEvent.change(content, { target: { value: "Second draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo memory draft change" }));
    expect(content).toHaveValue("First draft");
    fireEvent.click(screen.getByRole("button", { name: "Redo memory draft change" }));
    expect(content).toHaveValue("Second draft");
    fireEvent.click(screen.getByRole("button", { name: "Reset memory draft" }));
    expect(content).toHaveValue("");

    fireEvent.change(content, { target: { value: "Portable preview example" } });
    fireEvent.click(screen.getByRole("button", { name: /preview json \/ markdown/i }));
    const exportRegion = screen.getByRole("region", { name: "Memory draft portable preview" });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/omnia\.memory-draft-preview\.v1/i);
    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Memory draft export format" }), { target: { value: "markdown" } });
    expect(within(exportRegion).getByRole("code")).toHaveTextContent(/# Omnia memory draft preview/i);
    expect(screen.getByText(/no durable write/i)).toBeInTheDocument();
  });

  it("imports a portable JSON draft into the local history", async () => {
    render(<MemoryDraftStudio onClose={vi.fn()} onStage={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /preview json \/ markdown/i }));
    const payload = JSON.stringify({
      schema: "omnia.memory-draft-preview.v1",
      entry: {
        title: "Imported preference",
        content: "Prefer short implementation reports",
        scopeLabel: "Omnia project",
        kind: "preference",
        status: "active",
        origin: "imported",
        confidence: 0.8,
        sourceLabel: "Portable bundle",
        lastUsedLabel: "Not retrieved",
        expiresAt: "2030-01-01",
      },
    });
    const file = {
      name: "memory-draft.json",
      size: payload.length,
      text: vi.fn().mockResolvedValue(payload),
    };

    fireEvent.change(screen.getByLabelText("Import memory draft JSON or Markdown"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Memory content" })).toHaveValue("Prefer short implementation reports"));
    expect(screen.getByRole("combobox", { name: "Memory scope" })).toHaveValue("Omnia project");
    expect(screen.getByText(/imported memory-draft.json/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo memory draft change" }));
    expect(screen.getByRole("textbox", { name: "Memory content" })).toHaveValue("");
  });

  it("rejects non-Omnia JSON bundles before they reach the form", () => {
    expect(() => parseMemoryDraftPayload(JSON.stringify({ entry: { content: "unsafe" } }))).toThrow(/not an omnia memory draft/i);
    expect(() => parseMemoryDraftPayload("not json")).toThrow(/omnia json bundle or portable markdown/i);
  });

  it("round-trips portable Markdown metadata without durable writes", async () => {
    render(<MemoryDraftStudio onClose={vi.fn()} onStage={vi.fn()} />);

    const content = screen.getByRole("textbox", { name: "Memory content" });
    fireEvent.change(content, { target: { value: "Portable Markdown memory" } });
    fireEvent.click(screen.getByRole("button", { name: /preview json \/ markdown/i }));
    const exportRegion = screen.getByRole("region", { name: "Memory draft portable preview" });
    fireEvent.change(within(exportRegion).getByRole("combobox", { name: "Memory draft export format" }), { target: { value: "markdown" } });
    const markdown = within(exportRegion).getByRole("code").textContent ?? "";
    expect(markdown).toMatch(/omnia\.memory-draft-preview\.v1/);

    fireEvent.change(content, { target: { value: "Different local draft" } });

    const file = {
      name: "memory-draft.md",
      size: markdown.length,
      text: vi.fn().mockResolvedValue(markdown),
    };
    fireEvent.change(screen.getByLabelText("Import memory draft JSON or Markdown"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Memory content" })).toHaveValue("Portable Markdown memory"));
    expect(screen.getByText(/imported memory-draft\.md/i)).toBeInTheDocument();
  });
});
