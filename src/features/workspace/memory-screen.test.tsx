import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import MemoryScreen from "./activities/memory-screen";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("Memory Studio preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("links the active view tab to a focusable truthful panel", () => {
    render(<MemoryScreen />);

    const overview = screen.getByRole("tab", { name: "Overview" });
    expect(overview).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "memory-studio-tab-overview");
    expect(panel).toHaveTextContent(/native approval decision exists/i);

    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Entries" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Entries" })).toHaveFocus();
  });

  it("keeps local archive actions explicitly renderer-only", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Entries" }));
    const archive = screen.getByRole("button", { name: /archive local/i });
    fireEvent.click(archive);
    expect(screen.getByText(/renderer preview only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore local/i })).toBeInTheDocument();
  });

  it("supports reversible pause and forget previews without changing source records", () => {
    const memoriesBefore = useWorkspaceStore.getState().memories;
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Entries" }));
    fireEvent.click(screen.getByRole("button", { name: /pause in preview/i }));
    expect(screen.getByRole("button", { name: /resume in preview/i })).toBeInTheDocument();
    expect(screen.getByText(/paused in this renderer preview only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /forget in preview/i }));
    expect(screen.getByText(/content hidden after local forget preview/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore forgotten preview/i })).toBeInTheDocument();
    expect(screen.getByText(/source conversation and any synced copies remain unchanged/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /restore forgotten preview/i }));
    expect(screen.getAllByText(memoriesBefore[0]!.content).length).toBeGreaterThanOrEqual(1);
    expect(useWorkspaceStore.getState().memories).toBe(memoriesBefore);
  });

  it("keeps retrieval policy changes reversible inside the renderer preview", () => {
    const memoriesBefore = useWorkspaceStore.getState().memories;
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));

    const suggested = screen.getByRole("checkbox", { name: /include suggested entries/i });
    const confidence = screen.getByRole("slider", { name: /minimum confidence/i });
    expect(suggested).toBeChecked();
    expect(confidence).toHaveValue("0");

    fireEvent.click(suggested);
    fireEvent.change(confidence, { target: { value: "0.8" } });
    expect(suggested).not.toBeChecked();
    expect(confidence).toHaveValue("0.8");
    expect(screen.getByRole("button", { name: /undo memory policy preview change/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /undo memory policy preview change/i }));
    expect(confidence).toHaveValue("0");
    expect(suggested).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /undo memory policy preview change/i }));
    expect(suggested).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /redo memory policy preview change/i }));
    expect(confidence).toHaveValue("0");
    expect(suggested).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /redo memory policy preview change/i }));
    expect(confidence).toHaveValue("0.8");
    expect(suggested).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /reset memory policy preview/i }));
    expect(confidence).toHaveValue("0");
    expect(suggested).toBeChecked();
    expect(screen.getByText(/renderer-local and reversible/i)).toBeInTheDocument();
    expect(useWorkspaceStore.getState().memories).toBe(memoriesBefore);
  });

  it("offers reversible retrieval presets without claiming that native retrieval changed", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));
    const presetGroup = screen.getByRole("radiogroup", { name: "Memory policy presets" });
    expect(within(presetGroup).getByRole("radio", { name: /balanced/i })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(presetGroup).getByRole("radio", { name: /conservative/i }));
    expect(screen.getByRole("checkbox", { name: /include suggested entries/i })).not.toBeChecked();
    expect(screen.getByRole("slider", { name: /minimum confidence/i })).toHaveValue("0.8");
    expect(screen.getByRole("status", { name: "Memory policy route summary" })).toHaveTextContent(/conservative preset/i);
    expect(screen.getByText(/renderer-local and reversible/i)).toBeInTheDocument();
  });

  it("keeps sensitivity admission explicit and reversible in the renderer preview", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Policies" }));
    const mode = screen.getByRole("combobox", { name: "Memory sensitivity admission mode" });
    expect(mode).toHaveValue("review");
    expect(screen.getByRole("status", { name: "Memory sensitivity policy summary" })).toHaveTextContent(/Sensitive preview held/i);

    fireEvent.change(mode, { target: { value: "exclude" } });
    expect(mode).toHaveValue("exclude");
    expect(screen.getByRole("status", { name: "Memory sensitivity policy summary" })).toHaveTextContent(/Sensitive preview excluded/i);

    fireEvent.click(screen.getByRole("button", { name: /undo memory policy preview change/i }));
    expect(mode).toHaveValue("review");
    fireEvent.click(screen.getByRole("button", { name: /reset memory policy preview/i }));
    expect(mode).toHaveValue("review");
    expect(screen.getByText(/authentication, secret, and private-key categories are always blocked/i)).toBeInTheDocument();
  });

  it("previews filtered memory exports without implying durable persistence", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Entries" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));

    expect(screen.getByRole("region", { name: "Memory export preview" })).toHaveTextContent(/no durable write/i);
    expect(screen.getByRole("combobox", { name: "Memory export format" })).toHaveValue("json");
    expect(screen.getByRole("code")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Memory export format" }), { target: { value: "markdown" } });
    expect(screen.getByRole("code")).toHaveTextContent(/# Omnia memory preview/i);
    expect(screen.getByText(/does not approve, upload, persist, or activate memory/i)).toBeInTheDocument();
  });

  it("supports visible memory selection and selected-row export previews", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("tab", { name: "Entries" }));
    const memoryCheckboxes = screen.getAllByRole("checkbox", { name: /Select memory/ });
    expect(memoryCheckboxes.length).toBeGreaterThan(0);

    fireEvent.click(memoryCheckboxes[0]!);
    expect(screen.getByRole("toolbar", { name: "Memory entry selection actions" })).toHaveTextContent(/1 selected in this view/i);

    fireEvent.click(screen.getByRole("button", { name: "Preview export" }));
    const region = screen.getByRole("region", { name: "Memory export preview" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Memory export rows" }), { target: { value: "selected" } });
    expect(region).toHaveTextContent(/1 exportable entr/);
    expect(within(region).getByText(/selected renderer rows/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(screen.getByRole("toolbar", { name: "Memory entry selection actions" })).toHaveTextContent(new RegExp(`${memoryCheckboxes.length} selected in this view`, "i"));
    fireEvent.click(screen.getByRole("button", { name: "Clear visible" }));
    expect(screen.getByRole("toolbar", { name: "Memory entry selection actions" })).toHaveTextContent(/0 selected in this view/i);
  });

  it("parses and stages JSON memory imports without touching durable store state", () => {
    const memoriesBefore = useWorkspaceStore.getState().memories;
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("button", { name: /preview import/i }));
    const region = screen.getByRole("region", { name: "Memory import preview" });
    fireEvent.change(within(region).getByRole("textbox", { name: "Memory import payload" }), {
      target: {
        value: JSON.stringify({
          schema: "omnia.memory-preview.v1",
          entries: [{
            id: "memory-import-test",
            content: "Prefer compact implementation reports",
            scope: "Imported project",
            kind: "preference",
            status: "active",
            confidence: 0.95,
            source: "Portable bundle",
          }],
        }),
      },
    });
    fireEvent.click(within(region).getByRole("button", { name: /parse preview/i }));

    expect(within(region).getByText(/1 valid entry ready/i)).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: /stage in preview/i }));
    expect(screen.getByText("Prefer compact implementation reports")).toBeInTheDocument();
    expect(within(region).getByText(/staged 1 imported entry/i)).toBeInTheDocument();
    expect(useWorkspaceStore.getState().memories).toBe(memoriesBefore);
  });

  it("accepts portable Markdown bullets and reports invalid lines", () => {
    render(<MemoryScreen />);

    fireEvent.click(screen.getByRole("button", { name: /preview import/i }));
    const region = screen.getByRole("region", { name: "Memory import preview" });
    fireEvent.change(within(region).getByRole("combobox", { name: "Memory import format" }), { target: { value: "markdown" } });
    fireEvent.change(within(region).getByRole("textbox", { name: "Memory import payload" }), {
      target: {
        value: [
          "# Portable memory preview",
          "",
          "- **Use the project route for Omnia work** — Omnia Desktop · Workflow · Suggested · 86%",
          "- malformed entry",
        ].join("\n"),
      },
    });
    fireEvent.click(within(region).getByRole("button", { name: /parse preview/i }));

    expect(within(region).getByText(/1 valid entry ready/i)).toBeInTheDocument();
    expect(within(region).getByRole("list", { name: "Memory import warnings" })).toHaveTextContent(/skipped an invalid markdown entry/i);
    expect(within(region).getByText(/does not approve, upload, persist, or activate memory/i)).toBeInTheDocument();
  });
});
