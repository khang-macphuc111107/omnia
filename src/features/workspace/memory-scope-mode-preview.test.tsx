import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import MemoryScopeModePreview from "./memory-scope-mode-preview";

describe("Memory scope and mode preview", () => {
  it("starts with a project proposal posture and exposes typed scope choices", () => {
    render(<MemoryScopeModePreview />);

    expect(screen.getByRole("heading", { name: "Project · Propose" })).toBeInTheDocument();
    expect(screen.getByText(/renderer-local draft only/i)).toBeInTheDocument();
    const scopes = screen.getByRole("radiogroup", { name: "Memory scope options" });
    expect(within(scopes).getAllByRole("radio")).toHaveLength(4);
    expect(within(scopes).getByRole("radio", { name: "Global scope" })).toHaveAttribute("aria-checked", "false");
    expect(within(scopes).getByRole("radio", { name: "Project scope" })).toHaveAttribute("aria-checked", "true");
  });

  it("switches scope and mode in the renderer preview, with reversible history", () => {
    render(<MemoryScopeModePreview />);

    fireEvent.click(screen.getByRole("radio", { name: "Conversation scope" }));
    fireEvent.click(screen.getByRole("radio", { name: "Read-only mode" }));
    expect(screen.getByRole("heading", { name: "Conversation · Read-only" })).toBeInTheDocument();
    expect(screen.getByText(/Approved entries only/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Undo scope and mode preview change/i }));
    expect(screen.getByRole("heading", { name: "Conversation · Propose" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Redo scope and mode preview change/i }));
    expect(screen.getByRole("heading", { name: "Conversation · Read-only" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reset scope and mode preview/i }));
    expect(screen.getByRole("heading", { name: "Project · Propose" })).toBeInTheDocument();
  });

  it("reveals custom guardrails and keeps their changes local to the preview", () => {
    render(<MemoryScopeModePreview />);

    fireEvent.click(screen.getByRole("radio", { name: "Custom mode" }));
    const guardrails = screen.getByRole("group", { name: "Memory custom mode controls" });
    expect(within(guardrails).getByText(/Show sensitive candidates/i)).toBeInTheDocument();
    const sensitive = within(guardrails).getByRole("checkbox", { name: /Show sensitive candidates/i });
    expect(sensitive).not.toBeChecked();
    fireEvent.click(sensitive);
    expect(sensitive).toBeChecked();
    expect(screen.getByText(/does not write durable policy/i)).toBeInTheDocument();
  });

  it("shows the illustrative risk threshold only for auto-low-risk mode", () => {
    render(<MemoryScopeModePreview />);

    fireEvent.click(screen.getByRole("radio", { name: "Auto · low risk mode" }));
    const threshold = screen.getByRole("slider", { name: "Auto-approve threshold" });
    expect(threshold).toHaveValue("0.8");
    fireEvent.change(threshold, { target: { value: "0.9" } });
    expect(threshold).toHaveValue("0.9");
    expect(screen.getByText(/native risk scoring is not connected/i)).toBeInTheDocument();
  });
});
