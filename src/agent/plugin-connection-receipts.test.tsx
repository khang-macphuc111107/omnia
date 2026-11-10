import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({ agentApi: { pluginConnectionReceipts: vi.fn() }, errorMessage: (cause: unknown) => String(cause) }));
import { agentApi } from "./agent-api";
import { PluginConnectionReceipts } from "./plugin-connection-receipts";
import type { PluginConnectionReceipt } from "./types";

const receipt: PluginConnectionReceipt = {
  schemaVersion: 1, receiptId: "plugin_connection_receipt", pluginName: "github", pluginVersion: "1", pluginScope: "project",
  serverName: "plugin:github:api", configurationSha256: "a".repeat(64), configurationSnapshotSha256: "b".repeat(64),
  workspaceFingerprint: "c".repeat(64), workspaceTrusted: false, transport: "http", endpointOrigin: "https://api.github.com",
  requiredEnvironment: ["GITHUB_TOKEN"], missingEnvironment: ["GITHUB_TOKEN"], hasConfiguredHeaders: true,
  state: "workspace_trust_required", permissionBoundary: "workspace_trust_and_per_tool_policy", liveAuthenticationVerified: false,
};
const api = vi.mocked(agentApi);
beforeEach(() => { vi.clearAllMocks(); api.pluginConnectionReceipts.mockResolvedValue([receipt]); });
describe("PluginConnectionReceipts", () => {
  it("loads only on demand and shows exact native evidence without claiming login", async () => {
    render(<PluginConnectionReceipts sessionId="s" />);
    expect(api.pluginConnectionReceipts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect installed connectors" }));
    expect(await screen.findByText("plugin:github:api")).toBeInTheDocument();
    expect(api.pluginConnectionReceipts).toHaveBeenCalledWith("s");
    expect(screen.getByText(/Workspace trust required/)).toBeInTheDocument();
    expect(screen.getByText("Missing: GITHUB_TOKEN")).toBeInTheDocument();
    expect(screen.getByText(/Authentication: not verified/)).toBeInTheDocument();
    expect(screen.getByText("plugin_connection_receipt")).toBeInTheDocument();
  });
  it("refreshes the same session and handles inspection errors", async () => {
    render(<PluginConnectionReceipts sessionId="s" />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect installed connectors" }));
    await screen.findByText("plugin:github:api");
    api.pluginConnectionReceipts.mockRejectedValueOnce(new Error("Configuration unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh connector receipts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration unavailable");
    expect(screen.queryByText("plugin:github:api")).not.toBeInTheDocument();
  });
  it("discards stale results after changing session", async () => {
    let resolveOld: ((value: PluginConnectionReceipt[]) => void) | undefined;
    api.pluginConnectionReceipts.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const view = render(<PluginConnectionReceipts sessionId="old" />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect installed connectors" }));
    api.pluginConnectionReceipts.mockResolvedValueOnce([]);
    view.rerender(<PluginConnectionReceipts sessionId="new" />);
    await screen.findByText("No enabled plugin MCP configurations in this session.");
    resolveOld?.([receipt]);
    await waitFor(() => expect(screen.queryByText("plugin:github:api")).not.toBeInTheDocument());
  });
});
