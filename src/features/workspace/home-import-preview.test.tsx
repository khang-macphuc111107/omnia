import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeImportPreview, parseImport } from "./home-import-preview";

describe("home import preview", () => {
  it("summarizes a conversation JSON bundle without mutating workspace state", async () => {
    const file = new File(
      [JSON.stringify({ title: "Research sprint", messages: [{ role: "user" }, { role: "assistant" }] })],
      "research-sprint.json",
      { type: "application/json" },
    );

    render(<HomeImportPreview onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Choose import file"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Research sprint")).toBeInTheDocument());
    expect(screen.getByText("Conversation bundle · 2 visible records")).toBeInTheDocument();
    expect(screen.getByText(/no conversations, projects, files, or runs are changed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stage preview" }));
    expect(screen.getByRole("status")).toHaveTextContent(/No native import or durable write occurred/);
  });

  it("supports Markdown preview and resets the candidate", async () => {
    const file = new File(["# Imported note\n\n- one\n- two"], "note.md", { type: "text/markdown" });

    render(<HomeImportPreview onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Import source type"), { target: { value: "portable-markdown" } });
    fireEvent.change(screen.getByLabelText("Choose import file"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Imported note")).toBeInTheDocument());
    expect(screen.getByText("Portable Markdown · 3 visible records")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText(/Nothing selected yet/i)).toBeInTheDocument();
  });

  it("rejects files larger than the bounded preview limit", async () => {
    const file = new File(["x".repeat(512 * 1024 + 1)], "too-large.json", { type: "application/json" });

    render(<HomeImportPreview onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Choose import file"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/up to 512 KB/)).toBeInTheDocument());
    expect(screen.getByText(/Nothing selected yet/i)).toBeInTheDocument();
  });

  it("keeps the portable preview payload explicitly renderer-local", () => {
    const file = new File([JSON.stringify({ title: "Demo" })], "demo.json", { type: "application/json" });
    const candidate = parseImport(file, "chat-bundle", '{"title":"Demo"}');
    expect(candidate.title).toBe("Demo");
    expect(candidate.recordCount).toBe(1);
  });
});
