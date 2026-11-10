import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityRail } from "./activity-rail";
import { SHELL_VIEWS } from "./shell-view";

const noop = () => undefined;

describe("ActivityRail", () => {
  it("renders one labelled button per shell view plus Settings inside the Primary nav", () => {
    render(<ActivityRail view="agent" onNavigate={noop} onOpenSettings={noop} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const buttons = nav.querySelectorAll("button");
    expect(buttons).toHaveLength(SHELL_VIEWS.length + 1);
    expect(SHELL_VIEWS.map((entry) => entry.label)).toEqual(["Chat", "Browser", "IDE"]);
    for (const entry of SHELL_VIEWS) {
      const button = screen.getByRole("button", { name: entry.label });
      expect(button).toHaveAttribute("aria-keyshortcuts", entry.shortcut);
    }
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
  });

  it("pins Settings last, after a spacer, and opens it on click", () => {
    const onOpenSettings = vi.fn();
    const onNavigate = vi.fn();
    render(<ActivityRail view="agent" onNavigate={onNavigate} onOpenSettings={onOpenSettings} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(nav.lastElementChild).toBe(settings);
    expect(settings.previousElementSibling).toHaveClass("ag-rail__spacer");
    expect(settings).toHaveAttribute("aria-keyshortcuts", "Control+,");
    expect(settings).not.toHaveAttribute("aria-current");
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("marks only the active view with aria-current=page", () => {
    render(<ActivityRail view="browser" onNavigate={noop} onOpenSettings={noop} />);
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Chat" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Browser" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("tabindex", "-1");
  });

  it("navigates on click", () => {
    const onNavigate = vi.fn();
    render(<ActivityRail view="agent" onNavigate={onNavigate} onOpenSettings={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "IDE" }));
    expect(onNavigate).toHaveBeenCalledWith("code");
  });

  it("moves focus with ArrowUp/ArrowDown, wrapping, plus Home/End", () => {
    render(<ActivityRail view="agent" onNavigate={noop} onOpenSettings={noop} />);
    const home = screen.getByRole("button", { name: "Chat" });
    const projects = screen.getByRole("button", { name: "Browser" });
    const browser = screen.getByRole("button", { name: "IDE" });

    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    expect(projects).toHaveFocus();
    expect(projects).toHaveAttribute("tabindex", "0");
    expect(home).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(projects, { key: "ArrowUp" });
    expect(home).toHaveFocus();
    fireEvent.keyDown(home, { key: "ArrowUp" });
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "ArrowDown" });
    expect(home).toHaveFocus();
    fireEvent.keyDown(home, { key: "End" });
    expect(browser).toHaveFocus();
    fireEvent.keyDown(browser, { key: "Home" });
    expect(home).toHaveFocus();
  });

  it("describes focused controls with a tooltip outside the scrolling rail and dismisses it with Escape", () => {
    const onNavigate = vi.fn();
    render(<ActivityRail view="agent" onNavigate={onNavigate} onOpenSettings={noop} />);
    const code = screen.getByRole("button", { name: "IDE" });
    act(() => code.focus());
    const hint = screen.getByRole("tooltip");
    expect(hint).toHaveTextContent("IDEAlt+3");
    expect(code).toHaveAttribute("aria-describedby", hint.id);
    expect(screen.getByRole("navigation", { name: "Primary" })).not.toContainElement(hint);
    expect(code).toHaveAttribute("tabindex", "0");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(code, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(code).toHaveFocus();
    expect(code).not.toHaveAttribute("aria-describedby");
  });

  it("keeps pointer hints open while hovering the hint, then hides them on leaving", () => {
    vi.useFakeTimers();
    try {
      render(<ActivityRail view="agent" onNavigate={noop} onOpenSettings={noop} />);
      const settings = screen.getByRole("button", { name: "Settings" });
      fireEvent.mouseEnter(settings);
      const hint = screen.getByRole("tooltip");
      expect(settings).toHaveAttribute("aria-describedby", hint.id);
      fireEvent.mouseLeave(settings);
      fireEvent.mouseEnter(hint);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByRole("tooltip")).toBe(hint);
      fireEvent.mouseLeave(hint);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale tooltip positions after scrolling, resizing or navigating", () => {
    render(<ActivityRail view="agent" onNavigate={noop} onOpenSettings={noop} />);
    const browser = screen.getByRole("button", { name: "Browser" });
    fireEvent.mouseEnter(browser);
    fireEvent.scroll(screen.getByRole("navigation", { name: "Primary" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(browser);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(browser);
    fireEvent.click(browser);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
