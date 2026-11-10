import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RebuildApp } from "./rebuild-app";

afterEach(() => {
  try { window.localStorage.clear(); } catch { /* Vitest may not provide a storage file. */ }
  document.documentElement.dataset.rebuildTheme = "";
});

describe("clean-room Omnia shell", () => {
  it("starts in Chat and exposes exactly three primary surfaces", async () => {
    render(<RebuildApp />);
    await waitFor(() => expect(screen.getByText("Non-project chat")).toBeInTheDocument());
    const nav = screen.getByRole("navigation", { name: "Primary surfaces" });
    expect(nav.parentElement).toBe(screen.getByRole("banner"));
    expect(nav.previousElementSibling).toBeNull();
    expect(nav.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the selected session sidebar when Browser and IDE are opened", async () => {
    render(<RebuildApp />);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Sessions" })).getByRole("button", { name: /New conversation/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(screen.getByRole("region", { name: "Omnia native browser workspace" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Sessions" })).getByRole("button", { name: /New conversation/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Chat companion" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message composer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    expect(screen.getByRole("region", { name: "Omnia local IDE workspace" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Sessions" })).getByRole("button", { name: /New conversation/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Chat companion" })).toBeInTheDocument();
  });

  it("can open and dismiss companion chat without changing the workspace or draft", async () => {
    render(<RebuildApp />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message composer" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "Message composer" }), { target: { value: "Keep this research draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    // Layout visibility at 800px is checked in Playwright; JSDOM has no media layout.
    const toggle = screen.getByLabelText("Open chat companion", { selector: "button" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("textbox", { name: "Message composer" })).toHaveValue("Keep this research draft");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByLabelText("Open chat companion", { selector: "button" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "Omnia native browser workspace" })).toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it("moves focus into settings, contains Tab and restores focus after Escape", async () => {
    render(<RebuildApp />);
    const trigger = screen.getByRole("button", { name: "Open settings" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Advanced runtime" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const close = screen.getByRole("button", { name: "Close settings" });
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens unified session tabs and switches a newly created session without adding primary modes", async () => {
    render(<RebuildApp />);
    const tabs = await screen.findByRole("tablist", { name: "Open sessions" });
    expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(2));
    expect(screen.getByRole("navigation", { name: "Primary surfaces" }).querySelectorAll("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    expect(screen.getByRole("tablist", { name: "Open sessions" })).toBe(tabs);
  });

  it("opens real project context controls as a secondary dialog with focus restoration", async () => {
    render(<RebuildApp />);
    const trigger = screen.getByRole("button", { name: "Open project context" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Project context workspace" });
    expect(screen.getByLabelText("Context project")).toBeDisabled();
    expect(dialog).toHaveTextContent(/desktop runtime/i);
    expect(screen.getByRole("button", { name: /link files/i })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("exposes native goal/plan evidence controls without fabricating preview execution", async () => {
    render(<RebuildApp />);
    fireEvent.click(screen.getByRole("button", { name: "Open goals and plans" }));
    const dialog = screen.getByRole("dialog", { name: "Goals and plans" });
    expect(dialog).toHaveTextContent(/requires the Tauri desktop runtime/i);
    expect(screen.getByRole("button", { name: "New goal" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
