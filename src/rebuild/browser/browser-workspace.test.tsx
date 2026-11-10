import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "./browser-workspace";
import type { BrowserNativePort } from "./browser-controller";

function previewPort(): BrowserNativePort {
  return {
    available: false,
    attach: vi.fn(),
    update: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    capture: vi.fn(),
    release: vi.fn(),
  };
}

describe("BrowserWorkspace", () => {
  it("renders an explicit native-unavailable state and real controls in preview", () => {
    render(<BrowserWorkspace nativePort={previewPort()} />);
    expect(screen.getByRole("region", { name: "Omnia native browser workspace" })).toBeInTheDocument();
    expect(screen.getByText("Native WebView2 surface not connected")).toBeInTheDocument();
    expect(screen.getByText("preview", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("https://example.com/");
    expect(screen.getByRole("button", { name: "New browser tab" })).toBeInTheDocument();
  });

  it("supports tab creation and rejects an unsafe navigation address", () => {
    render(<BrowserWorkspace nativePort={previewPort()} />);
    fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "file:///C:/secret.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText(/Use an HTTP or HTTPS address/i)).toBeInTheDocument();
  });

  it("requires a native lease before capture", () => {
    render(<BrowserWorkspace nativePort={previewPort()} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    expect(screen.getByText(/Capture requires an attached native browser surface/i)).toBeInTheDocument();
  });

  it("keeps actions outside the tablist and supports arrow navigation and Delete", () => {
    render(<BrowserWorkspace nativePort={previewPort()} />);
    const add = screen.getByRole("button", { name: "New browser tab" });
    expect(screen.getByRole("tablist", { name: "Browser tabs" }).contains(add)).toBe(false);
    fireEvent.click(add);
    const tabs = screen.getAllByRole("tab");
    const firstTab = tabs.at(0);
    const secondTab = tabs.at(1);
    if (!firstTab || !secondTab) throw new Error("Expected two browser tabs after adding a tab");
    fireEvent.keyDown(secondTab, { key: "ArrowLeft" });
    expect(firstTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(firstTab);
    fireEvent.keyDown(firstTab, { key: "Delete" });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("exposes each tab close action as an independent keyboard control", () => {
    render(<BrowserWorkspace nativePort={previewPort()} />);
    const close = screen.getByRole("button", { name: "Close New page" });
    expect(close).toHaveAttribute("title", "Close New page");
    expect(screen.getByRole("tablist", { name: "Browser tabs" }).contains(close)).toBe(false);
    fireEvent.click(close);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
});
