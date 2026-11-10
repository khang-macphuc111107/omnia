import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeOperationsDeck } from "./home-operations-deck";

function renderDeck() {
  const callbacks = {
    onCreateChat: vi.fn(),
    onCreateProject: vi.fn(),
    onNavigate: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenLibrary: vi.fn(),
  };

  render(
    <HomeOperationsDeck
      conversationCount={4}
      projectCount={2}
      activeBackgroundWorkCount={3}
      attentionCount={1}
      libraryRecordCount={7}
      providerCount={2}
      {...callbacks}
    />,
  );

  return callbacks;
}

describe("HomeOperationsDeck", () => {
  it("renders the core operations and keeps renderer boundaries visible", () => {
    renderDeck();

    expect(screen.getByRole("region", { name: "Move through the workspace" })).toBeInTheDocument();
    expect(screen.getByText("Operations deck")).toBeInTheDocument();
    expect(screen.getByText("Preview only")).toBeInTheDocument();
    expect(screen.getByText("1", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText(/They do not dispatch a provider request/)).toBeInTheDocument();
  });

  it("routes each operation to its renderer-local action", () => {
    const callbacks = renderDeck();

    fireEvent.click(screen.getByRole("button", { name: /Start a focused chat/ }));
    fireEvent.click(screen.getByRole("button", { name: /Shape a project/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review attention work/ }));
    fireEvent.click(screen.getByRole("button", { name: /Find workspace context/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review the library/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tune the workspace/ }));

    expect(callbacks.onCreateChat).toHaveBeenCalledTimes(1);
    expect(callbacks.onCreateProject).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenSearch).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenLibrary).toHaveBeenCalledTimes(1);
    expect(callbacks.onNavigate).toHaveBeenNthCalledWith(1, "work");
    expect(callbacks.onNavigate).toHaveBeenNthCalledWith(2, "settings");
  });

  it("switches the work card to active-run copy when attention is clear", () => {
    const onNavigate = vi.fn();
    render(
      <HomeOperationsDeck
        conversationCount={0}
        projectCount={0}
        activeBackgroundWorkCount={1}
        attentionCount={0}
        libraryRecordCount={0}
        providerCount={0}
        onCreateChat={vi.fn()}
        onCreateProject={vi.fn()}
        onNavigate={onNavigate}
        onOpenSearch={vi.fn()}
        onOpenLibrary={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Inspect background work/ })).toBeInTheDocument();
    expect(screen.getByText("active run")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Inspect background work/ }));
    expect(onNavigate).toHaveBeenCalledWith("work");
  });

  it("keeps optional workbenches closed until the user explicitly selects one", () => {
    renderDeck();

    expect(screen.getByText(/No optional board is loaded yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Goals and tasks preview" })).not.toBeInTheDocument();

    const goals = screen.getByRole("button", { name: "Open Goals and tasks preview" });
    fireEvent.click(goals);

    expect(goals).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Goals and tasks preview" })).toBeInTheDocument();
    expect(screen.queryByText(/No optional board is loaded yet/i)).not.toBeInTheDocument();

    fireEvent.click(goals);
    expect(goals).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "Goals and tasks preview" })).not.toBeInTheDocument();
  });
});
