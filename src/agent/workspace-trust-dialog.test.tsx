import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause),
  agentApi: { workspaceTrust: vi.fn(), setWorkspaceTrust: vi.fn() },
}));
import { agentApi } from "./agent-api";
import { WorkspaceTrustDialog } from "./workspace-trust-dialog";

const status = { cwd: "C:\\project", fingerprint: "reviewed-fingerprint", trusted: false,
  sources: [{ path: "C:\\project\\.mcp.json", scope: "project" as const }] };
const api = vi.mocked(agentApi);
beforeEach(() => { vi.clearAllMocks(); api.workspaceTrust.mockResolvedValue(status); });

describe("WorkspaceTrustDialog", () => {
  it("reads status passively and requires explicit review before granting exact fingerprint", async () => {
    api.setWorkspaceTrust.mockResolvedValue({ ...status, trusted: true });
    render(<WorkspaceTrustDialog cwd={status.cwd} onClose={vi.fn()} />);
    const grant = await screen.findByRole("button", { name: "Trust reviewed configuration" });
    expect(api.workspaceTrust).toHaveBeenCalledWith(status.cwd);
    expect(api.setWorkspaceTrust).not.toHaveBeenCalled();
    expect(grant).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(grant);
    await waitFor(() => expect(api.setWorkspaceTrust).toHaveBeenCalledWith(status.cwd, status.fingerprint, true));
    expect(await screen.findByRole("button", { name: "Revoke workspace trust" })).toBeEnabled();
  });

  it("fails closed on changed configuration and never retries a grant", async () => {
    api.setWorkspaceTrust.mockRejectedValue(new Error("Configuration changed since review"));
    render(<WorkspaceTrustDialog cwd={status.cwd} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Trust reviewed configuration" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Trust reviewed configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration changed since review");
    expect(screen.queryByRole("button", { name: "Trust reviewed configuration" })).not.toBeInTheDocument();
    expect(api.setWorkspaceTrust).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByRole("button", { name: "Trust reviewed configuration" })).toBeDisabled();
  });

  it("keeps full long paths and fingerprints available in the scrollable review region", async () => {
    const cwd = `C:\\${"long-directory".repeat(80)}`;
    const path = `${cwd}\\.mcp.json`;
    const fingerprint = "a".repeat(256);
    api.workspaceTrust.mockResolvedValue({ ...status, cwd, fingerprint, sources: [{ path, scope: "project" }] });
    render(<WorkspaceTrustDialog cwd={cwd} onClose={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Workspace configuration review" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(await screen.findByTitle(path)).toHaveTextContent(path);
    expect(screen.getByTitle(cwd)).toHaveTextContent(cwd);
    expect(region).toHaveTextContent(`Fingerprint: ${fingerprint}`);
    expect(region).not.toContainElement(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toHaveClass("ag-workspace-trust");
  });

  it("focuses the heading, traps Tab and Shift+Tab, and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<WorkspaceTrustDialog cwd={status.cwd} onClose={onClose} />);
    const heading = screen.getByRole("heading", { name: "Workspace trust" });
    await waitFor(() => expect(heading).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    const region = screen.getByRole("region", { name: "Workspace configuration review" });
    fireEvent.keyDown(heading, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(region).toHaveFocus();
    fireEvent.keyDown(region, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener when unmounted", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<WorkspaceTrustDialog cwd={status.cwd} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading")).toHaveFocus());
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("preserves an enabled focus target during refresh and trust changes", async () => {
    render(<WorkspaceTrustDialog cwd={status.cwd} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Trust reviewed configuration" });
    await waitFor(() => expect(screen.getByRole("heading")).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    refresh.focus();
    fireEvent.click(refresh);
    expect(close).toHaveFocus();
    await screen.findByRole("button", { name: "Trust reviewed configuration" });
    api.setWorkspaceTrust.mockResolvedValue({ ...status, trusted: true });
    fireEvent.click(screen.getByRole("checkbox"));
    const grant = screen.getByRole("button", { name: "Trust reviewed configuration" });
    grant.focus();
    fireEvent.click(grant);
    expect(close).toHaveFocus();
    expect(close).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Revoke workspace trust" })).toBeEnabled();
    expect(close).toHaveFocus();
  });

  it("revokes with the reviewed cwd and fingerprint", async () => {
    api.workspaceTrust.mockResolvedValue({ ...status, trusted: true });
    api.setWorkspaceTrust.mockResolvedValue(status);
    render(<WorkspaceTrustDialog cwd={status.cwd} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke workspace trust" }));
    await waitFor(() => expect(api.setWorkspaceTrust).toHaveBeenCalledWith(status.cwd, status.fingerprint, false));
  });
});
