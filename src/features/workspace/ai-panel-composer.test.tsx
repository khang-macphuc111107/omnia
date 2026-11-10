import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { AiPanelComposer, type AiPanelComposerProps } from "./ai-panel-composer";

function ControlledComposer(props: Partial<AiPanelComposerProps> = {}) {
  const [value, setValue] = useState(props.value ?? "");
  return <AiPanelComposer {...props} value={value} onChange={setValue} onSend={props.onSend ?? (() => undefined)} />;
}

describe("shared review AI composer", () => {
  it("uses the exact quiet placeholder and footer with real controls only", () => {
    const attach = vi.fn();
    const send = vi.fn();
    const { container } = render(<ControlledComposer value="Review this" onAttach={attach} onSend={send} models={[{ id: "sol", label: "gpt-6.1-sol" }]} modelId="sol" onModelChange={() => undefined} efforts={[{ id: "max", label: "Max" }]} effortId="max" onEffortChange={() => undefined} />);

    expect(screen.getByRole("textbox", { name: "Message AI" })).toHaveAttribute("placeholder", "Ask anything...");
    const footer = container.querySelector(".review-composer-footer") as HTMLElement;
    expect(within(footer).getAllByRole("button")).toHaveLength(2);
    expect(within(footer).getAllByRole("combobox")).toHaveLength(2);
    const attachButton = screen.getByRole("button", { name: "Attach files" });
    expect(attachButton).toHaveAttribute("title", "Attach files");
    expect(attachButton.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    expect(attachButton.textContent).toBe("");
    fireEvent.click(attachButton);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(attach).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(container).not.toHaveTextContent(/Harness|Cache|tok\/s|Local:|Run \(↵\)/i);
  });

  it("does not invent a model or reasoning capability without provider choices", () => {
    render(<ControlledComposer />);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Reasoning effort" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "No model" })).toBeInTheDocument();
    expect(screen.queryByText("gpt-6.1-sol")).not.toBeInTheDocument();
    expect(screen.queryByText("Max")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("forwards actual model and effort selections to the owner", () => {
    const onModelChange = vi.fn();
    const onEffortChange = vi.fn();
    render(<ControlledComposer models={[{ id: "a", label: "Model A" }, { id: "b", label: "Model B" }]} modelId="a" onModelChange={onModelChange} efforts={[{ id: "high", label: "High" }, { id: "max", label: "Max" }]} effortId="high" onEffortChange={onEffortChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "b" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reasoning effort" }), { target: { value: "max" } });
    expect(onModelChange).toHaveBeenCalledWith("b");
    expect(onEffortChange).toHaveBeenCalledWith("max");
  });

  it("keeps genuine file/context chips compact, typed, removable, and line-aware", () => {
    const remove = vi.fn();
    const { container } = render(<ControlledComposer attachments={[{ id: "source", label: "provider_gateway.rs:864-898", onRemove: remove }, { id: "tabs", label: "@all-tabs", kind: "tab" }]} />);
    expect(screen.getByText("provider_gateway.rs")).toBeInTheDocument();
    expect(screen.getByText(":864-898")).toBeInTheDocument();
    expect(screen.getByText("@all-tabs")).toBeInTheDocument();
    expect(container.querySelector(".lucide-file-code-2")).not.toBeNull();
    expect(screen.getByText("@all-tabs").closest(".review-composer-chip")?.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    const button = screen.getByRole("button", { name: "Remove provider_gateway.rs" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.queryByText("@all-3-tabs")).not.toBeInTheDocument();
  });

  it.each(["Tab", "Enter"])("selects a filtered slash command with %s without sending", (key) => {
    const send = vi.fn();
    render(<ControlledComposer onSend={send} />);
    const input = screen.getByRole("textbox", { name: "Message AI" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/check", selectionStart: 6, selectionEnd: 6 } });
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key });
    expect(input).toHaveValue("- [ ] ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("supports arrow navigation, mouse selection and Escape dismissal", () => {
    const send = vi.fn();
    render(<ControlledComposer onSend={send} />);
    const input = screen.getByRole("textbox", { name: "Message AI" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/", selectionStart: 1, selectionEnd: 1 } });
    const options = screen.getAllByRole("option").filter((option) => option.tagName !== "OPTION");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyUp(input, { key: "ArrowDown" });
    fireEvent.select(input);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyUp(input, { key: "Escape" });
    fireEvent.select(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("/");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
    expect(input).toHaveValue("/");
    fireEvent.change(input, { target: { value: "/code", selectionStart: 5, selectionEnd: 5 } });
    fireEvent.click(screen.getByRole("option", { name: /\/code Code block/ }));
    expect(input).toHaveValue("```typescript\n\n```");
  });

  it("preserves Shift+Enter and blocks duplicate submissions while pending", () => {
    const send = vi.fn();
    const { rerender } = render(<ControlledComposer value="Review" onSend={send} />);
    const input = screen.getByRole("textbox", { name: "Message AI" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    rerender(<ControlledComposer value="Review" pending onSend={send} />);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });
});
