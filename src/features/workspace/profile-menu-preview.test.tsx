import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileMenuPreview } from "./profile-menu-preview";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("ProfileMenuPreview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-sw-palette");
    globalThis.localStorage?.removeItem("omnia.sovereign.palette.v1");
  });

  it("opens an accessible profile menu and returns focus on Escape", () => {
    render(<ProfileMenuPreview />);
    const trigger = screen.getByRole("button", { name: "Khang profile menu" });

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Profile menu" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Settings & providers/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color theme" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Downloads \(Ultra IDM\+\)/ })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Profile menu" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("offers five themes and applies the selected palette and store preference", () => {
    render(<ProfileMenuPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Khang profile menu" }));

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "VS Code Dark+" }));
    expect(useWorkspaceStore.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.swPalette).toBe("vscode-dark");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(useWorkspaceStore.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.swPalette).toBe("dark");
    const tokyoNight = screen.getByRole("menuitemradio", { name: "Tokyo Night" });
    fireEvent.click(tokyoNight);
    expect(tokyoNight).toHaveAttribute("aria-checked", "true");
    expect(useWorkspaceStore.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.swPalette).toBe("tokyo-night");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(useWorkspaceStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.swPalette).toBe("light");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "System" }));
    expect(useWorkspaceStore.getState().theme).toBe("system");
    expect(document.documentElement.hasAttribute("data-sw-palette")).toBe(false);
  });

  it("keeps the selected theme aligned with store changes from Settings", () => {
    useWorkspaceStore.setState({ theme: "light" });
    render(<ProfileMenuPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Khang profile menu" }));
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

    act(() => useWorkspaceStore.getState().setTheme("system"));
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.hasAttribute("data-sw-palette")).toBe(false);
  });

  it("opens the keyboard shortcuts dialog from the profile menu", async () => {
    render(<ProfileMenuPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Khang profile menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));

    expect(screen.queryByRole("menu", { name: "Profile menu" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("opens Ultra IDM+ Downloads in the Library activity from the profile menu", () => {
    const received: Array<{ workbenchId?: string }> = [];
    const handleOpen = (event: Event) => {
      received.push((event as CustomEvent<{ workbenchId?: string }>).detail);
    };
    window.addEventListener("omnia:open-sovereign-workbench", handleOpen);

    render(<ProfileMenuPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Khang profile menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Downloads \(Ultra IDM\+\)/ }));

    expect(received).toEqual([{ workbenchId: "idm-downloader" }]);
    expect(useWorkspaceStore.getState().activeActivity).toBe("library");
    expect(screen.queryByRole("menu", { name: "Profile menu" })).not.toBeInTheDocument();

    window.removeEventListener("omnia:open-sovereign-workbench", handleOpen);
  });

  it("provides reversible renderer-local session lock and settings navigation", () => {
    render(<ProfileMenuPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Khang profile menu" }));

    const lock = screen.getByRole("menuitemcheckbox", { name: /Lock session/ });
    expect(lock).toHaveAttribute("aria-checked", "false");
    fireEvent.click(lock);
    expect(lock).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/lock preview enabled/i);

    fireEvent.click(screen.getByRole("menuitem", { name: /Settings & providers/ }));
    expect(useWorkspaceStore.getState().activeActivity).toBe("settings");
    expect(screen.queryByRole("menu", { name: "Profile menu" })).not.toBeInTheDocument();
  });
});
