import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceInputPreview } from "./voice-input-preview";

describe("VoiceInputPreview", () => {
  it("exposes language and transcript insertion controls", () => {
    const onLanguageChange = vi.fn();
    const onInsertModeChange = vi.fn();
    const onToggleListening = vi.fn();

    render(
      <VoiceInputPreview
        available
        state="idle"
        language="vi-VN"
        insertMode="append"
        onLanguageChange={onLanguageChange}
        onInsertModeChange={onInsertModeChange}
        onToggleListening={onToggleListening}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(onToggleListening).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Voice input options" }));
    expect(screen.getByRole("dialog", { name: "Voice input options" })).toBeInTheDocument();
    expect(screen.getByText(/Browser preview/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Recognition language"), { target: { value: "en-US" } });
    fireEvent.change(screen.getByLabelText("Insert transcript"), { target: { value: "replace" } });

    expect(onLanguageChange).toHaveBeenCalledWith("en-US");
    expect(onInsertModeChange).toHaveBeenCalledWith("replace");
  });

  it("keeps the stop affordance active while listening", () => {
    render(
      <VoiceInputPreview
        available
        state="listening"
        language="vi-VN"
        insertMode="append"
        onLanguageChange={vi.fn()}
        onInsertModeChange={vi.fn()}
        onToggleListening={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop voice input" })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes options with Escape and returns focus to the options trigger", () => {
    render(
      <VoiceInputPreview
        available
        state="idle"
        language="vi-VN"
        insertMode="append"
        onLanguageChange={vi.fn()}
        onInsertModeChange={vi.fn()}
        onToggleListening={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Voice input options" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Voice input options" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Voice input options" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes options on an outside pointer without stealing focus", () => {
    render(
      <VoiceInputPreview
        available
        state="idle"
        language="vi-VN"
        insertMode="append"
        onLanguageChange={vi.fn()}
        onInsertModeChange={vi.fn()}
        onToggleListening={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Voice input options" });
    fireEvent.click(trigger);
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Outside control";
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.pointerDown(outside);

    expect(screen.queryByRole("dialog", { name: "Voice input options" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(outside);
  });
});
