import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpStatus } from "./mcp-status";
import { agentApi } from "./agent-api";
import type { McpServerStatus } from "./types";

vi.mock("./agent-api", () => ({
  agentApi: { mcpStatus: vi.fn(), reloadMcp: vi.fn() },
  errorMessage: (cause: unknown) => String(cause),
}));
const api = vi.mocked(agentApi);

beforeEach(() => {
  vi.resetAllMocks();
  api.mcpStatus.mockResolvedValue([]);
  api.reloadMcp.mockResolvedValue([]);
});

describe("McpStatus", () => {
  it("provides a named keyboard-focusable scroll region and remains passive", async () => {
    render(<McpStatus sessionId="s" />);
    const region = screen.getByRole("region", { name: "MCP connection status" });
    expect(region).toHaveAttribute("tabindex", "0");
    region.focus();
    expect(region).toHaveFocus();
    expect(await screen.findByText("No current MCP connections.")).toBeInTheDocument();
    expect(api.mcpStatus).toHaveBeenCalledWith("s");
    expect(api.reloadMcp).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart MCP servers" })).toBeDisabled();
  });

  it("keeps long names and multiline errors intact inside the scroll region", async () => {
    const name = "server-".repeat(100);
    const error = `${"C:/very/long/path/".repeat(100)}\nConnection failed`;
    api.mcpStatus.mockResolvedValue([{ name, error, state: "failed", toolCount: 0 }]);
    render(<McpStatus sessionId="s" />);
    const server = await screen.findByText(name);
    const region = screen.getByRole("region", { name: "MCP connection status" });
    expect(region).toContainElement(server);
    expect(region.querySelector(".ag-error")?.textContent).toBe(error);
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("0 tools")).toBeInTheDocument();
  });

  it("announces restart progress, locks controls and restores focus to confirmation", async () => {
    let resolve!: (servers: McpServerStatus[]) => void;
    api.reloadMcp.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<McpStatus sessionId="s" />);
    await screen.findByText("No current MCP connections.");
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    const button = screen.getByRole("button", { name: "Restart MCP servers" });
    button.focus();
    fireEvent.click(button);
    expect(checkbox).toBeDisabled();
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Restarting MCP servers…");
    expect(screen.getByRole("region", { name: "MCP connection status" })).toHaveAttribute("aria-busy", "true");
    resolve([]);
    await waitFor(() => expect(checkbox).toHaveFocus());
    expect(checkbox).not.toBeChecked();
    expect(button).toBeDisabled();
    expect(api.reloadMcp).toHaveBeenCalledExactlyOnceWith("s");
  });

  it("reports restart failure without stealing focus from another control", async () => {
    let reject!: (cause: Error) => void;
    api.reloadMcp.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    render(<><McpStatus sessionId="s" /><button type="button">Close</button></>);
    await screen.findByText("No current MCP connections.");
    fireEvent.click(screen.getByRole("checkbox"));
    const restart = screen.getByRole("button", { name: "Restart MCP servers" });
    restart.focus();
    fireEvent.click(restart);
    screen.getByRole("button", { name: "Close" }).focus();
    reject(new Error("Restart failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Restart failed");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
