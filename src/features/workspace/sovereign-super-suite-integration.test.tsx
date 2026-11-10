import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import LibraryActivityScreen from "./activities/library-activity-screen";
import MemoryScreen from "./activities/memory-screen";
import { useWorkspaceStore } from "./store";
import { TitleBar } from "./title-bar";

const initialState = useWorkspaceStore.getState();

// Library no longer has a quick-switch chip strip; workbenches open through the
// same event other surfaces (profile menu, stream capture) dispatch.
function openWorkbench(workbenchId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent("omnia:open-sovereign-workbench", { detail: { workbenchId } }));
  });
}

describe("Omnia Sovereign Super-Suite End-to-End Integration", () => {
  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    document.body.innerHTML = "";
    delete window.__OMNIA_PENDING_WORKBENCH__;
    delete window.__OMNIA_PENDING_DOWNLOAD_URL__;
  });

  it("keeps TitleBar quiet while deliberate Studio tools still reach Browser downloads, Calculator, Session DFS, Memory Graph, and the real IDE", async () => {
    render(
      <>
        <TitleBar />
        <LibraryActivityScreen />
      </>,
    );

    // Image 7: URI copy belongs only to a chat item's context menu, never
    // back in the top-level titlebar. Optional utilities remain reachable
    // from intentional library navigation without advertising backend work.
    expect(screen.queryByRole("button", { name: /Copy live session URI/i })).not.toBeInTheDocument();
    expect(document.querySelector(".title-bar")).not.toHaveTextContent(/omnia:\/\/sessions\//i);
    expect(screen.getByRole("group", { name: /Primary workspace mode/i })).toBeInTheDocument();

    // 2. Open SovereignBrowserWorkbench via Browser quick button
    openWorkbench("sovereign-browser");

    await waitFor(
      () => {
        expect(screen.getByRole("heading", { name: "Sovereign Browser & F12" })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // DevTools starts closed and is revealed only by an explicit toolbar
    // action. Network inspection still uses the existing functional path.
    const devTools = await screen.findByTestId("toggle-devtools-btn", {}, { timeout: 10000 });
    expect(devTools).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("sovereign-f12-devtools-dock")).not.toBeInTheDocument();
    fireEvent.click(devTools);
    const networkTab = await screen.findByTestId("devtools-tab-network", {}, { timeout: 10000 });
    fireEvent.click(networkTab);
    expect(screen.getByTestId("devtools-panel-network")).toBeInTheDocument();

    // 3. Downloads is a deliberate drawer, not a permanently visible AI tab.
    fireEvent.click(screen.getByTestId("sniffed-media-badge"));
    const downloads = screen.getByTestId("sniffed-media-drawer");
    fireEvent.click(within(downloads).getByTestId("handoff-idm-btn"));

    const openIdmBannerBtn = await screen.findByRole(
      "button",
      {
        name: /Open in Ultra IDM\+ Downloader/i,
      },
      { timeout: 10000 },
    );
    fireEvent.click(openIdmBannerBtn);

    await waitFor(
      () => {
        expect(screen.getByRole("heading", { name: "Ultra IDM+ Downloader" })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 4. Open Built-in Calculator & Anti-Hallucination Verifier
    openWorkbench("calculator-verifier");
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Calculator & Anti-Hallucination" }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 5. Open Recursive Session DFS Tree (A -> B -> C)
    openWorkbench("session-dfs");
    await waitFor(
      () => {
        expect(screen.getByRole("heading", { name: "Session DFS Tree" })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 6. Switch to LTST Memory Graph & 9 Official Harnesses
    openWorkbench("knowledge-tree");
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Knowledge Tree & Harnesses" }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 7. Open VS Code IDE Workbench
    openWorkbench("sovereign-ide-remote");
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Sovereign IDE & Remote Desktop" }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
  }, 25000);

  it("mounts the LTST Knowledge Tree & 9 Harnesses inside MemoryScreen Learning tab", async () => {
    render(<MemoryScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Learning log" }));
    expect(
      await screen.findByTestId("knowledge-tree-explorer", {}, { timeout: 10000 }),
    ).toBeInTheDocument();
  }, 20000);
});
