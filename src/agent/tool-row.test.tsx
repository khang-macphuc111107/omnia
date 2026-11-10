import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/workspace/markdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { PREVIEW_LINES, ToolRow } from "./tool-row";
import { DIFF_PREVIEW_LINES } from "./transcript";
import { emptyLive, type LiveState, type ToolItem } from "./transcript";
import { TranscriptView } from "./transcript-view";

const make = (id: string, name: string, status: ToolItem["status"] = "ok", extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool", key: `k-${id}`, id, name, input: { id }, summary: `${name} ${id}`, status, output: `out ${id}`, progress: "", partialJson: "", sub: null, ...extra,
});
const liveWith = (items: ToolItem[], running = false): LiveState => ({ ...emptyLive(), items, running });

describe("tool run grouping", () => {
  it("collapses finished calls behind one row and expands them on click", () => {
    render(<TranscriptView live={liveWith([make("a", "read_file"), make("b", "read_file"), make("c", "edit_file")])} onDecide={vi.fn()} />);
    const group = screen.getByRole("button", { name: /Edited 1 file · read 2/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /read_file a/ })).not.toBeInTheDocument();
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: /(read_file|edit_file) [abc] Done/ })).toHaveLength(3);
  });

  it("keeps a failed call visible between groups", () => {
    render(<TranscriptView live={liveWith([make("a", "grep"), make("b", "grep"), make("x", "bash", "error"), make("c", "grep"), make("d", "grep")])} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: /bash x Failed/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Searched 2 times/ })).toHaveLength(2);
  });

  it("keeps a group open while the run appends more calls", () => {
    const first = [make("a", "read_file"), make("b", "read_file")];
    const { rerender } = render(<TranscriptView live={liveWith(first)} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Explored 2 files/ }));
    rerender(<TranscriptView live={liveWith([...first, make("c", "read_file"), make("r", "bash", "running")])} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Explored 3 files/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /bash r Running/ })).toBeInTheDocument();
  });

  it("keeps an inspected tool row mounted while a run is still changing", () => {
    const first = make("a", "read_file");
    const { rerender } = render(<TranscriptView live={liveWith([first], true)} onDecide={vi.fn()} />);
    const row = screen.getByRole("button", { name: /read_file a Done/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");

    rerender(<TranscriptView live={liveWith([first, make("b", "read_file")], true)} onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: /read_file a Done/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a fifth or fewer of the rows for a long collapsed run", () => {
    const tools = Array.from({ length: 60 }, (_, index) =>
      index % 10 === 9 ? make(String(index), "bash", "error") : make(String(index), "read_file"),
    );
    const { container } = render(<TranscriptView live={liveWith(tools)} onDecide={vi.fn()} />);
    expect(container.querySelectorAll(".ag-tool").length).toBeLessThanOrEqual(60 / 5);
  });
});

describe("ToolRow body", () => {
  it("previews the last output lines and shows all on request", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(<ToolRow item={make("a", "bash", "ok", { output })} />);
    fireEvent.click(screen.getByRole("button", { name: /bash a Done/ }));
    const pre = () => container.querySelector(".ag-tool__body pre")!.textContent;
    expect(pre()).toBe(Array.from({ length: PREVIEW_LINES }, (_, index) => `line ${index + 13}`).join("\n"));
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 lines" }));
    expect(pre()).toBe(output);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("does not count the trailing newline as an extra output line", () => {
    const output = Array.from({ length: PREVIEW_LINES }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const { container } = render(<ToolRow item={make("a", "bash", "ok", { output })} />);
    fireEvent.click(screen.getByRole("button", { name: /bash a Done/ }));
    expect(container.querySelector(".ag-tool__body pre")?.textContent).toBe(output);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("keeps the raw input behind a closed Details toggle", () => {
    render(<ToolRow item={make("a", "bash")} />);
    fireEvent.click(screen.getByRole("button", { name: /bash a Done/ }));
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/"id": "a"/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/"id": "a"/)).toBeInTheDocument();
  });

  it("previews the first output lines of a read", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(<ToolRow item={make("a", "read_file", "ok", { input: { path: "a.ts" }, output })} />);
    fireEvent.click(screen.getByRole("button", { name: "Read a.ts Done" }));
    expect(container.querySelector(".ag-tool__body pre")!.textContent).toBe(Array.from({ length: PREVIEW_LINES }, (_, index) => `line ${index + 1}`).join("\n"));
  });
});

describe("ToolRow edits", () => {
  const edit = (lines: number, extra: Partial<ToolItem> = {}) =>
    make("e", "edit_file", "ok", {
      input: { path: "src/a.ts", old_string: Array.from({ length: lines }, (_, index) => `old ${index}`).join("\n"), new_string: "new" },
      output: "Edited src/a.ts (1 replacement)",
      ...extra,
    });

  it("shows verb, target and delta on one collapsed line without raw JSON", () => {
    const { container } = render(<ToolRow item={edit(3)} />);
    const head = screen.getByRole("button", { name: "Edited src/a.ts +1 −3 Done" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".ag-tool__add")?.textContent).toBe("+1");
    expect(container.querySelector(".ag-tool__del")?.textContent).toBe("−3");
    expect(container.textContent).not.toContain("old_string");
  });

  it("truncates the diff preview and shows more on request", () => {
    const { container } = render(<ToolRow item={edit(20)} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited src\/a.ts/ }));
    const rows = () => container.querySelectorAll(".ag-diff__line").length;
    expect(rows()).toBe(DIFF_PREVIEW_LINES);
    expect(container.querySelector(".ag-diff__line--del")?.textContent).toContain("old 0");
    expect(screen.queryByText(/Edited src\/a.ts \(1 replacement\)/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more (9)" }));
    expect(rows()).toBe(21);
    expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument();
  });

  it("opens the full diff in the Changes panel", () => {
    const listener = vi.fn();
    window.addEventListener("omnia:open-changes", listener);
    render(<ToolRow item={edit(2)} />);
    fireEvent.click(screen.getByRole("button", { name: /Edited src\/a.ts/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open in Changes" }));
    window.removeEventListener("omnia:open-changes", listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ path: "src/a.ts" });
  });

  it("starts open when asked and still collapses on click", () => {
    const { container } = render(<ToolRow item={edit(2)} defaultOpen />);
    const head = screen.getByRole("button", { name: /Edited src\/a.ts/ });
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll(".ag-diff__line")).toHaveLength(3);
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the error output of a failed edit", () => {
    render(<ToolRow item={edit(2, { status: "error", output: "old_string not found" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit src\/a.ts .*Failed/ }));
    expect(screen.getByText("old_string not found")).toBeInTheDocument();
  });
});
