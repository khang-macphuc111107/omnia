import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeQuickAccess } from "./home-quick-access";

describe("home quick access", () => {
  it("activates shortcuts and filters visible actions", () => {
    const onActivate = vi.fn();
    render(<HomeQuickAccess onActivate={onActivate} metrics={{ chats: 4 }} />);

    expect(screen.getByRole("heading", { name: "Your workspace, one click away" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chats/ })).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(onActivate).toHaveBeenCalledWith("new-chat");

    fireEvent.change(screen.getByPlaceholderText("Filter shortcuts"), { target: { value: "chats" } });
    expect(screen.getByRole("button", { name: /Chats/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^New chat Start a focused conversation/ })).not.toBeInTheDocument();
  });

  it("supports session-only customization, reorder, and undo", () => {
    render(<HomeQuickAccess onActivate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByText("Customize shortcuts")).toBeInTheDocument();
    const newChatCheckbox = screen.getByRole("checkbox", { name: "New chat" });
    fireEvent.click(newChatCheckbox);
    expect(screen.queryByRole("button", { name: /^New chat Start a focused conversation/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: /^New chat Start a focused conversation/ })).toBeInTheDocument();
    expect(screen.getByText(/Renderer-local · Session-only · No durable write/)).toBeInTheDocument();
  });

  it("resets and exports a configuration preview without claiming persistence", async () => {
    render(<HomeQuickAccess onActivate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(screen.getByRole("button", { name: /^New chat Start a focused conversation/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Import / export configuration"));
    fireEvent.click(screen.getByRole("button", { name: /Copy JSON/ }));
    expect(await screen.findByText(/Quick Access JSON is ready|Copied the Quick Access JSON/)).toBeInTheDocument();
  });
});
