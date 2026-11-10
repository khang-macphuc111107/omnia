import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "./approval-card";
import type { ApprovalRequest } from "./types";

const request = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  tool_use_id: "t1",
  tool: "shell",
  input: { command: "rm -rf build" },
  summary: "rm -rf build",
  ordinal: 1,
  total: 1,
  ...patch,
});

const queued = (tool: string, id: string) => ({ tool_use_id: id, tool, input: {}, summary: `${tool} call` });

describe("edit before allow", () => {
  it("allows the edited shell command as allow_edited", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "rm -rf build/tmp" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow edited" }));
    expect(onDecide).toHaveBeenCalledWith("t1", { type: "allow_edited", input: { command: "rm -rf build/tmp" } });
  });

  it("falls back to allow_once when nothing changed", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith("t1", { type: "allow_once" });
  });

  it("validates JSON in the raw editor and refuses invalid input", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request({ tool: "custom_tool", input: { a: 1 } })} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Tool input (JSON)");
    fireEvent.change(editor, { target: { value: "{ not json" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Allow (edited|once)/ }));
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: '{"a": 2}' } });
    fireEvent.click(screen.getByRole("button", { name: "Allow edited" }));
    expect(onDecide).toHaveBeenCalledWith("t1", { type: "allow_edited", input: { a: 2 } });
  });

  it("does not deny when Escape is pressed inside the editor", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard request={request()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByLabelText("Command"), { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe("batch approval", () => {
  it("hides batch buttons when only one approval is pending", () => {
    render(<ApprovalCard request={request()} onDecide={vi.fn()} onDecideAll={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /all pending/ })).toBeNull();
  });

  it("asks for confirmation when a pending call is a shell command, then decides all", () => {
    const onDecideAll = vi.fn();
    render(
      <ApprovalCard
        request={request({ total: 2, remaining: [queued("read_file", "t2")] })}
        onDecide={vi.fn()}
        onDecideAll={onDecideAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow all pending (2)" }));
    expect(onDecideAll).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes, allow all 2" }));
    expect(onDecideAll).toHaveBeenCalledWith("t1", { type: "allow_once" });
  });

  it("Escape cancels the confirmation", () => {
    const onDecideAll = vi.fn();
    render(<ApprovalCard request={request({ total: 2, remaining: [queued("write_file", "t2")] })} onDecide={vi.fn()} onDecideAll={onDecideAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny all pending (2)" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onDecideAll).not.toHaveBeenCalled();
  });

  it("decides immediately when every pending call is read-only", () => {
    const onDecideAll = vi.fn();
    render(
      <ApprovalCard
        request={request({ tool: "read_file", input: { path: "a" }, summary: "a", total: 2, remaining: [queued("grep", "t2")] })}
        onDecide={vi.fn()}
        onDecideAll={onDecideAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow all pending (2)" }));
    expect(onDecideAll).toHaveBeenCalledWith("t1", { type: "allow_once" });
  });

  it("supports the keyboard shortcut", () => {
    const onDecideAll = vi.fn();
    render(
      <ApprovalCard
        request={request({ tool: "read_file", input: {}, total: 2, remaining: [queued("grep", "t2")] })}
        onDecide={vi.fn()}
        onDecideAll={onDecideAll}
      />,
    );
    fireEvent.keyDown(screen.getByRole("group", { name: "Approval required" }), { key: "Backspace", ctrlKey: true, shiftKey: true });
    expect(onDecideAll).toHaveBeenCalledWith("t1", { type: "deny", feedback: null });
  });
});
