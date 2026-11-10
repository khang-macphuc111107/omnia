import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: { servicesStatus: vi.fn(), browserSettingsSet: vi.fn(), browserClearData: vi.fn(), browserOpenForSignin: vi.fn(), setComputerPermission: vi.fn(), downloadControl: vi.fn(), mcpStatus: vi.fn(async () => []), reloadMcp: vi.fn(async () => []) },
}));
import { agentApi } from "./agent-api";
import { ServicesDialog } from "./services-dialog";
import type { AgentServicesStatus } from "./types";
const status: AgentServicesStatus = {
  browser: { available: true, launchPolicy: "lazy_dedicated_persistent_profile", personalBrowser: false, keepSignIns: true, profileMode: "persistent" },
  ffmpeg: { available: false, path: null, configuredPath: null },
  computer: { available: true, capture: false, control: false, defaultDisabled: true },
  downloads: { available: true, destination: "C:\\app\\downloads", restoredJobsRequireReauthorization: true, jobs: [
    { job: { id: "restored", status: "paused", outputPath: null, error: null, errorCode: null }, reauthorizationRequired: true },
  ] },
};
const api = vi.mocked(agentApi);
beforeEach(() => { vi.clearAllMocks(); api.servicesStatus.mockResolvedValue(status); api.setComputerPermission.mockResolvedValue(status); });
// Role queries over this large dialog are slow when the whole suite runs in parallel.
describe("ServicesDialog", { timeout: 20_000 }, () => {
  it("inspects passively, never grants on mount, and disables restored download resume", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Grant selected desktop permissions" })).toBeDisabled();
    expect(api.setComputerPermission).not.toHaveBeenCalled();
    expect(api.downloadControl).not.toHaveBeenCalled();
    expect(api.mcpStatus).toHaveBeenCalledWith("s");
    expect(api.reloadMcp).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart MCP servers" })).toBeDisabled();
  });
  it("requires separate capture/control consent and exact executable basenames", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(screen.getByRole("checkbox", { name: /I allow desktop capture/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I also allow desktop control/ }));
    const grant = screen.getByRole("button", { name: "Grant selected desktop permissions" });
    expect(grant).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Allowed executable basenames/), { target: { value: "*.exe" } });
    expect(grant).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Allowed executable basenames/), { target: { value: "notepad.exe, Code.exe" } });
    fireEvent.click(grant);
    await waitFor(() => expect(api.setComputerPermission).toHaveBeenCalledWith("s", true, true, ["notepad.exe", "Code.exe"]));
  });
  it("starts MCP only after explicit process-start confirmation", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Start or restart the configured MCP server processes now." }));
    fireEvent.click(screen.getByRole("button", { name: "Restart MCP servers" }));
    await waitFor(() => expect(api.reloadMcp).toHaveBeenCalledWith("s"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart MCP servers" })).toBeDisabled());
  });
  it("toggles keep sign-ins and shows the profile mode", async () => {
    api.browserSettingsSet.mockResolvedValue({ keepSignIns: false, profileInUse: false, ffmpeg: { available: false, path: null, configuredPath: null } });
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/Saved profile \(sign-ins kept\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep browser sign-ins" }));
    await waitFor(() => expect(api.browserSettingsSet).toHaveBeenCalledWith("s", { keepSignIns: false }));
  });
  it("shows the fallback mode when the saved profile is busy", async () => {
    api.servicesStatus.mockResolvedValue({ ...status, browser: { ...status.browser, profileMode: "disposable_fallback" } });
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/saved profile is in use by another session/)).toBeInTheDocument();
  });
  it("opens the browser for sign-in only on click, validating the URL", async () => {
    api.browserOpenForSignin.mockResolvedValue(status);
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    const open = await screen.findByRole("button", { name: "Open browser to sign in" });
    expect(api.browserOpenForSignin).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Sign-in page/), { target: { value: "javascript:alert(1)" } });
    expect(open).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Sign-in page/), { target: { value: "https://example.com/login" } });
    fireEvent.click(open);
    await waitFor(() => expect(api.browserOpenForSignin).toHaveBeenCalledWith("s", "https://example.com/login"));
  });
  it("clears browser data only after confirmation", async () => {
    api.browserClearData.mockResolvedValue({ keepSignIns: true, profileInUse: false, ffmpeg: { available: false, path: null, configuredPath: null } });
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear browser data" }));
    expect(api.browserClearData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear data" }));
    await waitFor(() => expect(api.browserClearData).toHaveBeenCalledTimes(1));
  });
  it("reports ffmpeg status and saves a custom path", async () => {
    api.browserSettingsSet.mockResolvedValue({ keepSignIns: true, profileInUse: false, ffmpeg: { available: true, path: "/opt/ffmpeg/ffmpeg", configuredPath: "/opt/ffmpeg/ffmpeg" } });
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/ffmpeg not found/, {}, { timeout: 5000 })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Custom ffmpeg path/), { target: { value: "/opt/ffmpeg/ffmpeg" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ffmpeg path" }));
    await waitFor(() => expect(api.browserSettingsSet).toHaveBeenCalledWith("s", { ffmpegPath: "/opt/ffmpeg/ffmpeg" }), { timeout: 5000 });
  });
  it("focuses the scrollable settings region and traps Tab at both ends", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Service settings" });
    await waitFor(() => expect(region).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(region).toHaveFocus();
    expect(region).toHaveClass("ag-services-dialog__body");
    expect(screen.getByRole("dialog", { name: "Session services" })).toHaveClass("ag-services-dialog");
    expect(region).not.toContainElement(close);
  });
  it("closes with Escape and restores focus to the launcher", async () => {
    const onClose = vi.fn();
    const launcher = document.createElement("button");
    document.body.appendChild(launcher);
    launcher.focus();
    const view = render(<ServicesDialog sessionId="s" onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Service settings" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });
  it("dismisses only the nested confirmation on Escape and returns focus", async () => {
    const onClose = vi.fn();
    render(<ServicesDialog sessionId="s" onClose={onClose} />);
    const clear = await screen.findByRole("button", { name: "Clear browser data" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Service settings" })).toHaveFocus());
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Clear data" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.browserClearData).not.toHaveBeenCalled();
    expect(clear).toHaveFocus();
    fireEvent.keyDown(clear, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("keeps long service values intact inside the settings scroll region", async () => {
    const destination = `C:\\downloads\\${"long-directory".repeat(30)}`;
    api.servicesStatus.mockResolvedValue({ ...status, downloads: { ...status.downloads, destination } });
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Service settings" })).toContainElement(await screen.findByText(destination));
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });
  it("revokes explicitly without granting capture or control", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke desktop access" }));
    await waitFor(() => expect(api.setComputerPermission).toHaveBeenCalledWith("s", false, false, []));
  });
  it("exposes bounded upstream adapter metadata without launching anything", async () => {
    render(<ServicesDialog sessionId="s" onClose={vi.fn()} />);
    const inspect = await screen.findByRole("button", { name: "Inspect catalog" });
    expect(screen.getByText(/extracted modules across/)).toBeInTheDocument();
    fireEvent.click(inspect);
    expect(screen.getByRole("combobox", { name: "Category" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Extracted upstream modules" })).toBeInTheDocument();
    expect(screen.getByText(/Catalog data is generated from/)).toBeInTheDocument();
    expect(api.servicesStatus).toHaveBeenCalledTimes(1);
    expect(api.setComputerPermission).not.toHaveBeenCalled();
  });
});
