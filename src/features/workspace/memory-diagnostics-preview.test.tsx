import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AppRuntimeInfo } from "@/lib/desktop";

import MemoryScreen from "./activities/memory-screen";
import { useWorkspaceStore } from "./store";

// The inspector is lazy-loaded; a cold transform can exceed the default 1s findBy window.
const LAZY = { timeout: 10_000 };

const browserRuntime: AppRuntimeInfo = {
  appName: "Omnia",
  appVersion: "0.1.0",
  platform: "windows",
  tauri: false,
  debug: true,
};

const initialState = useWorkspaceStore.getState();

describe("Memory diagnostics inspector preview", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("opens from Memory Studio and reports renderer-local memory evidence", async () => {
    render(<MemoryScreen runtime={browserRuntime} />);

    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));

    expect(await screen.findByRole("region", { name: "Memory diagnostics inspector" }, LAZY)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory diagnostics inspector" })).toBeInTheDocument();
    expect(screen.getByText("Source projections")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Session Log Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Memory diagnostics boundary" })).toHaveTextContent(
      /no native retrieval.*provider request/i,
    );
    expect(screen.getByRole("button", { name: "Hide diagnostics" })).toHaveAttribute("aria-expanded", "true");
  });

  it("closes without changing the memory store", async () => {
    const memoriesBefore = useWorkspaceStore.getState().memories;
    render(<MemoryScreen runtime={browserRuntime} />);

    fireEvent.click(screen.getByRole("button", { name: "Open diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close memory diagnostics preview" }, LAZY));

    expect(screen.queryByRole("region", { name: "Memory diagnostics inspector" })).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().memories).toBe(memoriesBefore);
    expect(screen.getByRole("button", { name: "Open diagnostics" })).toHaveAttribute("aria-expanded", "false");
  });
});
