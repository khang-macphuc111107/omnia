import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MessageFeedbackPreview } from "./message-feedback-preview";

describe("message feedback renderer preview", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("captures a local choice, reason, and note without claiming native telemetry", () => {
    render(<MessageFeedbackPreview messageId="message-feedback" />);

    const helpful = screen.getByRole("button", { name: "Helpful (renderer preview)" });
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "true");
    const dialog = screen.getByRole("dialog", { name: "Message feedback preview" });
    expect(dialog).toBeInTheDocument();
    expect(helpful).toHaveAttribute("aria-expanded", "true");
    expect(helpful).toHaveAttribute("aria-controls", dialog.id);
    expect(dialog).toHaveAttribute("aria-describedby");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Not helpful (renderer preview)" }));
    fireEvent.click(screen.getByRole("button", { name: "Incomplete" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback note (renderer preview)" }), {
      target: { value: "Add a concrete example." },
    });
    expect(screen.getByRole("note")).toHaveTextContent(/does not send telemetry/i);

    fireEvent.click(screen.getByRole("button", { name: /Save preview/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no telemetry or native write was sent/i);
  });

  it("switches reason vocabulary and restores trigger focus on Escape", () => {
    render(<MessageFeedbackPreview messageId="message-feedback-focus" />);

    const helpful = screen.getByRole("button", { name: "Helpful (renderer preview)" });
    fireEvent.click(helpful);
    fireEvent.click(screen.getByRole("button", { name: "Accurate" }));
    expect(screen.getByRole("button", { name: "Accurate" })).toHaveAttribute("aria-pressed", "true");

    const notHelpful = screen.getByRole("button", { name: "Not helpful (renderer preview)" });
    fireEvent.click(notHelpful);
    expect(screen.queryByRole("button", { name: "Accurate" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Incomplete" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Message feedback preview" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(notHelpful);
  });
});
