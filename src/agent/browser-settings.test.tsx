import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalSurface } from "@/components/modal-surface";
import { agentApi } from "./agent-api";
import { BrowserSettingsSection } from "./browser-settings";
import type { AgentServicesStatus } from "./types";

vi.mock("./agent-api", () => ({
  agentApi: {
    browserSettingsSet: vi.fn().mockResolvedValue(undefined),
    browserOpenForSignin: vi.fn().mockResolvedValue(undefined),
    browserClearData: vi.fn().mockResolvedValue(undefined),
  },
}));

const status: AgentServicesStatus = {
  browser: { available: true, launchPolicy: "explicit", personalBrowser: false, profileMode: "disposable_fallback" },
  ffmpeg: { available: true, path: `C:/${"long-directory/".repeat(30)}ffmpeg.exe`, configuredPath: "" },
  downloads: { available: true, destination: "", jobs: [], restoredJobsRequireReauthorization: false },
  computer: { available: false, capture: false, control: false, defaultDisabled: true },
};
const act = async (action: () => Promise<unknown>) => { await action(); };
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("browser settings", () => {
  it("keeps complete profile and long path text in a scoped responsive section", () => {
    render(<BrowserSettingsSection sessionId="session" status={status} busy={false} act={act} />);
    const section = screen.getByRole("region", { name: "Browser sign-ins" });
    expect(section).toHaveClass("ag-browser-settings");
    expect(within(section).getByText(/saved profile is in use by another session/)).toBeVisible();
    expect(within(section).getByText(`ffmpeg found: ${status.ffmpeg!.path}`)).toBeVisible();
    expect(within(section).getByLabelText("Custom ffmpeg path (blank to auto-detect)")).toHaveValue("");
  });

  it("focuses Cancel, wraps keyboard focus, and Escape closes only the nested confirmation", async () => {
    const closeParent = vi.fn();
    render(<ModalSurface className="test-modal" title="Services" onClose={closeParent}>
      <BrowserSettingsSection sessionId="session" status={status} busy={false} act={act} />
    </ModalSurface>);
    await nextFrame();
    const opener = screen.getByRole("button", { name: "Clear browser data" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Clear browser data" });
    expect(dialog).toHaveClass("ag-browser-settings__confirm");
    expect(dialog).toHaveAccessibleDescription(/This signs you out of every site/);
    await nextFrame();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Clear data" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Clear browser data" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(closeParent).not.toHaveBeenCalled();
    expect(agentApi.browserClearData).not.toHaveBeenCalled();
  });

  it("only clears data after explicit confirmation and disables confirmation while busy", () => {
    const { rerender } = render(<BrowserSettingsSection sessionId="session" status={status} busy={false} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear browser data" }));
    rerender(<BrowserSettingsSection sessionId="session" status={status} busy act={act} />);
    expect(screen.getByRole("button", { name: "Clear data" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear data" }));
    expect(agentApi.browserClearData).not.toHaveBeenCalled();
    rerender(<BrowserSettingsSection sessionId="session" status={status} busy={false} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear data" }));
    expect(agentApi.browserClearData).toHaveBeenCalledOnce();
  });

  it("validates sign-in URLs and saves trimmed ffmpeg paths", () => {
    render(<BrowserSettingsSection sessionId="session" status={status} busy={false} act={act} />);
    const url = screen.getByLabelText("Sign-in page (optional)");
    const open = screen.getByRole("button", { name: "Open browser to sign in" });
    fireEvent.change(url, { target: { value: "https://user:pass@example.com" } });
    expect(open).toBeDisabled();
    fireEvent.change(url, { target: { value: " https://example.com/login " } });
    fireEvent.click(open);
    expect(agentApi.browserOpenForSignin).toHaveBeenCalledWith("session", "https://example.com/login");
    fireEvent.change(screen.getByLabelText("Custom ffmpeg path (blank to auto-detect)"), { target: { value: " C:/tools/ffmpeg.exe " } });
    fireEvent.click(screen.getByRole("button", { name: "Save ffmpeg path" }));
    expect(agentApi.browserSettingsSet).toHaveBeenCalledWith("session", { ffmpegPath: "C:/tools/ffmpeg.exe" });
  });
});
