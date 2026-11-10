import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TitleBar } from "./title-bar";
import { useWorkspaceStore } from "./store";

const initialState = useWorkspaceStore.getState();

describe("TitleBar", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
    delete window.__TAURI_INTERNALS__;
  });

  it("keeps native window controls visibly unavailable in the browser preview", () => {
    render(<TitleBar />);

    expect(screen.getByRole("button", { name: "Minimize" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Maximize or restore" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Forward (planned)" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize" })).toHaveAttribute(
      "title",
      "Minimize window (desktop app only)",
    );
  });

  it("keeps title-bar actions limited to window controls, with no inspector or duplicated location", () => {
    useWorkspaceStore.setState({ activeActivity: "chats", inspectorOpen: false });
    render(<TitleBar />);

    expect(screen.queryByRole("button", { name: "Toggle inspector" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Window controls" })).toBeInTheDocument();

    const actions = document.querySelector(".title-bar__actions");
    expect(actions).toBeInTheDocument();
    expect(within(actions as HTMLElement).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByTestId("copy-title-session-uri-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-open-downloads-btn")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Theme palette" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show keyboard shortcuts" })).not.toBeInTheDocument();
    expect(screen.queryByText(/omnia:\/\/sessions\//)).not.toBeInTheDocument();

    expect(document.querySelector(".title-bar__breadcrumb")).not.toBeInTheDocument();
    expect(document.querySelector(".title-bar__brand")).not.toBeInTheDocument();
    expect(screen.queryByText(useWorkspaceStore.getState().conversations[0]!.title)).not.toBeInTheDocument();
  });

  it("hides the inspector action outside the Chat and Project workspace", () => {
    useWorkspaceStore.setState({ activeActivity: "library" });
    render(<TitleBar />);

    expect(screen.queryByRole("button", { name: "Toggle inspector" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
  });

  it("centers only the mode switcher and keeps the left sidebar toggle functional", () => {
    useWorkspaceStore.setState({ sidebarOpen: true });
    render(<TitleBar />);

    const center = document.querySelector(".title-bar__center");
    expect(center).toBeInTheDocument();
    expect(within(center as HTMLElement).getByRole("group", { name: "Primary workspace mode" })).toBeInTheDocument();
    expect(within(center as HTMLElement).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Open commands and navigation, Control K" })).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    expect(toggle).toHaveAttribute("title", "Toggle sidebar");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.querySelector("svg")).toHaveAttribute("stroke-width", "1.75");
    expect(toggle).toHaveTextContent("");
    fireEvent.click(toggle);
    expect(useWorkspaceStore.getState().sidebarOpen).toBe(false);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
