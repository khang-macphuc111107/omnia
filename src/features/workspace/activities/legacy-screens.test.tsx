import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "../store";
import HomeScreen from "./home-screen";
import SettingsScreen from "./settings-screen";

const initialState = useWorkspaceStore.getState();

describe("legacy Home and Settings activity screens", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
  });

  it("points Home to the single Home hub entry point", () => {
    useWorkspaceStore.setState({ activeActivity: "home" });
    render(<HomeScreen />);
    expect(screen.getByRole("heading", { name: "Home", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Home" }));
    expect(useWorkspaceStore.getState().activeActivity).toBe("chats");
  });

  it("points Settings to the rail Settings dialog without duplicating it", () => {
    render(<SettingsScreen />);
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/bottom of the rail \(Ctrl\+,\)/)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});
