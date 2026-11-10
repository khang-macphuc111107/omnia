import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResearchNotebookPreview } from "./research-notebook-preview";

describe("research notebook preview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a grounded canvas with an explicit renderer-only boundary", () => {
    render(<ResearchNotebookPreview />);

    expect(screen.getByRole("region", { name: "Research notebook preview" })).toBeInTheDocument();
    expect(screen.getByText("No retrieval or file access is running here.")).toBeInTheDocument();
    expect(screen.getByText("How can Omnia make research inspectable without hiding uncertainty?")).toBeInTheDocument();
    expect(screen.getAllByText("72%").length).toBeGreaterThan(0);
  });

  it("filters sources and keeps the selected source detail visible", () => {
    render(<ResearchNotebookPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));
    expect(screen.getByRole("button", { name: /Harness architecture notes/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search notebook sources" }), {
      target: { value: "memory" },
    });

    expect(screen.getByText("Local-first memory discussion")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Harness architecture notes/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Local-first memory discussion/ }));
    expect(screen.getByRole("heading", { name: "Local-first memory discussion" })).toBeInTheDocument();
    expect(screen.getAllByText(/inferred facts must not silently become active context/i).length).toBeGreaterThan(0);
  });

  it("creates an editable note and drafts a deterministic brief", () => {
    render(<ResearchNotebookPreview />);

    fireEvent.click(screen.getByRole("button", { name: /New note/ }));
    expect(screen.getByRole("tab", { name: /Notes/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByDisplayValue("Untitled note")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Untitled note"), { target: { value: "Follow-up" } });
    expect(screen.getByDisplayValue("Follow-up")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Brief draft/ }));
    fireEvent.click(screen.getByRole("button", { name: /Draft synthesis preview/ }));
    expect(screen.getByText(/Omnia's research surface should make source provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/no provider request was sent/i)).toBeInTheDocument();
  });

  it("integrates the citation graph as a first-class notebook view", () => {
    render(<ResearchNotebookPreview />);

    fireEvent.click(screen.getByRole("tab", { name: /Evidence graph/ }));

    expect(screen.getByRole("tabpanel", { name: "Notebook evidence graph" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Citation graph preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Citation graph" })).toBeInTheDocument();
  });

  it("supports roving keyboard navigation across notebook tabs", () => {
    render(<ResearchNotebookPreview />);

    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Sources/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /Sources/ }), { key: "End" });
    expect(screen.getByRole("tab", { name: /Evidence graph/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /Evidence graph/ }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /Brief draft/ })).toHaveAttribute("aria-selected", "true");
  });

  it("filters sources by type and evidence state", () => {
    render(<ResearchNotebookPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));

    fireEvent.change(screen.getByRole("combobox", { name: "Filter notebook sources by type" }), { target: { value: "web" } });
    expect(screen.getByText("Provider comparison scratchpad")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Harness architecture notes/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Filter notebook sources by type" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter notebook sources by evidence state" }), { target: { value: "review" } });
    expect(screen.getByText("Local-first memory discussion")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Provider comparison scratchpad/ })).not.toBeInTheDocument();
  });

  it("sorts the filtered source list and resets sorting with the source view", () => {
    render(<ResearchNotebookPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));

    const sort = screen.getByRole("combobox", { name: "Sort notebook sources by" });
    fireEvent.change(sort, { target: { value: "title" } });
    const titleSorted = screen.getAllByRole("button").filter((button) =>
      button.classList.contains("research-notebook__source-card"),
    );
    expect(titleSorted.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Context compiler research"),
      expect.stringContaining("Harness architecture notes"),
      expect.stringContaining("Local-first memory discussion"),
      expect.stringContaining("Provider comparison scratchpad"),
    ]);

    fireEvent.change(sort, { target: { value: "citations" } });
    const citationSorted = screen.getAllByRole("button").filter((button) =>
      button.classList.contains("research-notebook__source-card"),
    );
    expect(citationSorted[0]).toHaveTextContent("Harness architecture notes");
    expect(citationSorted[1]).toHaveTextContent("Context compiler research");

    fireEvent.click(screen.getByRole("button", { name: "Reset source view" }));
    expect(sort).toHaveValue("default");
  });

  it("edits note tags and links the selected source in preview", () => {
    render(<ResearchNotebookPreview />);
    fireEvent.click(screen.getByRole("tab", { name: /Notes/ }));
    fireEvent.click(screen.getByRole("button", { name: /Open question: source freshness/ }));

    fireEvent.change(screen.getByRole("textbox", { name: "Note tags" }), { target: { value: "freshness, follow-up, review" } });
    expect(screen.getByDisplayValue("freshness, follow-up, review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Link selected source/ }));
    expect(screen.getByText("Context compiler research · Provider comparison scratchpad · Harness architecture notes")).toBeInTheDocument();
    expect(screen.getByText(/Linked Harness architecture notes in this renderer-local note/i)).toBeInTheDocument();
  });
});
