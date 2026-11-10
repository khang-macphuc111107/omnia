import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/desktop", () => ({ invokeCore: vi.fn() }));
vi.mock("./agent-api", () => ({ errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)) }));
vi.mock("./update-api", () => ({
  updateApi: { getSettings: vi.fn(), setSettings: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn(), onEvent: vi.fn() },
}));
import { updateApi, type UpdateCheckResult, type UpdateEventPayload, type UpdateSettings } from "./update-api";
import { invokeCore } from "@/lib/desktop";
import { UpdateBadge, UpdatesSection } from "./updates";

const api = vi.mocked(updateApi);
const base: UpdateSettings = {
  feedUrl: "",
  autoCheck: false,
  currentVersion: "0.1.0",
  keyConfigured: false,
  keyInvalid: false,
  keyFingerprint: null,
  allowUnsigned: false,
  unsignedAllowed: false,
  availableVersion: null,
  availableCandidate: null,
  pendingReset: false,
  generation: 0,
  platform: "windows-x86_64",
};
let emit: (payload: UpdateEventPayload) => void = () => undefined;

beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue(base);
  api.onEvent.mockImplementation(async (handler) => {
    emit = handler;
    return () => undefined;
  });
});

describe("Updates section", () => {
  it("saves the feed with Enter, but not during IME composition", async () => {
    const feed = "https://example.com/u.json";
    api.setSettings.mockResolvedValue({ ...base, feedUrl: feed });
    render(<UpdatesSection />);
    await screen.findByText(/no update feed/);
    const input = screen.getByRole("textbox", { name: "Update feed URL" });
    fireEvent.change(input, { target: { value: feed } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(api.setSettings).not.toHaveBeenCalled();
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith(feed, false, undefined));
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.setSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on status when a focused action is removed, without stealing focus on completion", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", keyConfigured: true, availableVersion: "0.2.0", availableCandidate: 1 });
    let finish!: () => void;
    api.download.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<UpdatesSection />);
    const download = await screen.findByRole("button", { name: "Download" });
    download.focus();
    fireEvent.click(download);
    expect(screen.getByRole("status")).toHaveFocus();
    const feed = screen.getByRole("textbox", { name: "Update feed URL" });
    feed.focus();
    await act(async () => finish());
    expect(await screen.findByRole("button", { name: "Install and restart" })).toBeEnabled();
    expect(feed).toHaveFocus();
  });

  it("exposes long release notes as a keyboard-scrollable region and associates feed errors", async () => {
    const longText = "a".repeat(2000);
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", currentVersion: longText, keyConfigured: true, keyFingerprint: longText })
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", keyConfigured: true, availableVersion: longText, availableCandidate: 1 });
    api.check.mockResolvedValue({ current: longText, latest: longText, available: true, notes: longText, size: 1, signatureVerified: true, candidate: 1, generation: 0, pubDate: null });
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    const notes = await screen.findByRole("region", { name: "Release notes" });
    expect(notes).toHaveAttribute("tabindex", "0");
    expect(notes).toHaveClass("ag-updates__notes");
    expect(notes).toHaveTextContent(longText);
    notes.focus();
    expect(notes).toHaveFocus();
    api.setSettings.mockRejectedValue(new Error(longText));
    const input = screen.getByRole("textbox", { name: "Update feed URL" });
    fireEvent.change(input, { target: { value: "invalid" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
  });
  it("is idle with no feed: no check possible, shows version", async () => {
    render(<UpdatesSection />);
    expect(await screen.findByText(/no update feed is configured/)).toBeInTheDocument();
    expect(screen.getByText("Current version: 0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Check automatically on startup/ })).toBeDisabled();
    expect(api.check).not.toHaveBeenCalled();
  });

  it("saves the feed and shows the unsigned-feed warning", async () => {
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json" });
    render(<UpdatesSection />);
    await screen.findByText(/no update feed/);
    fireEvent.change(screen.getByLabelText("Update feed URL"), { target: { value: "https://example.com/u.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save feed" }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith("https://example.com/u.json", false, undefined));
    expect(await screen.findByText(/Unsigned feed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
  });

  it("surfaces an invalid feed rejection", async () => {
    api.setSettings.mockRejectedValue(new Error("must use https://"));
    render(<UpdatesSection />);
    await screen.findByText(/no update feed/);
    fireEvent.change(screen.getByLabelText("Update feed URL"), { target: { value: "http://x.test/u" } });
    fireEvent.click(screen.getByRole("button", { name: "Save feed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must use https://");
  });

  it("walks check, download with progress, then install", async () => {
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", keyConfigured: true, keyFingerprint: "0123456789abcdef" })
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", keyConfigured: true, keyFingerprint: "0123456789abcdef", availableVersion: "0.2.0", availableCandidate: 1 });
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "<b>Fixes</b>", size: 2048, signatureVerified: true, candidate: 1, generation: 0, pubDate: null });
    let finish: () => void = () => undefined;
    api.download.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    api.install.mockResolvedValue(undefined);
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    expect(screen.queryByText(/Unsigned feed/)).not.toBeInTheDocument();
    expect(screen.getByText(/fingerprint: 0123456789abcdef/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Allow unsigned updates/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/Update 0\.2\.0 is available/)).toBeInTheDocument();
    // Notes are plain text, never markup.
    expect(screen.getByText("<b>Fixes</b>")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const operationId = api.download.mock.calls[0]![2];
    act(() => emit({ kind: "progress", received: 1024, total: 2048, candidate: 1, generation: 0, operationId }));
    expect(await screen.findByText(/Downloading update… 50%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Update download progress" })).toHaveAttribute("value", "50");
    act(() => emit({ kind: "ready", received: 2048, total: 2048, candidate: 1, generation: 0, operationId }));
    finish();
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(api.install).toHaveBeenCalled());
  });

  it("reports up to date and download errors", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json" });
    api.check.mockResolvedValueOnce({ current: "0.1.0", latest: "0.1.0", available: false, notes: "", size: 0, signatureVerified: false, candidate: 1, generation: 0, pubDate: null });
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/up to date \(0\.1\.0\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();

    api.check.mockRejectedValueOnce(new Error("Could not reach the update server"));
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach");
  });

  it("clears a previously available candidate after an up-to-date check", async () => {
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.2.0", availableCandidate: 4, allowUnsigned: true })
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json" });
    api.check.mockResolvedValue({ current: "0.2.0", latest: "0.2.0", available: false, notes: "", size: 0, signatureVerified: false, candidate: 5, generation: 0, pubDate: null });
    render(<UpdatesSection />);
    expect(await screen.findByRole("button", { name: "Download" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/up to date/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Update 0\.2\.0 is available/)).not.toBeInTheDocument();
  });

  it("keeps downloads blocked until unsigned updates are explicitly allowed, with a strong warning", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.3.0", availableCandidate: 3 });
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.3.0", availableCandidate: 3, allowUnsigned: true });
    render(<UpdatesSection />);
    expect(await screen.findByRole("button", { name: "Download" })).toBeDisabled();
    expect(screen.queryByTestId("unsigned-warning")).not.toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Allow unsigned updates (I trust this feed)" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith("https://example.com/u.json", false, true));
    expect(await screen.findByTestId("unsigned-warning")).toHaveTextContent(/WARNING: unsigned updates are enabled/);
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("flags unsigned installs on the install button and refuses an invalid built-in key", async () => {
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", allowUnsigned: true })
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", allowUnsigned: true, availableVersion: "0.2.0", availableCandidate: 1 });
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 1, generation: 0, pubDate: null });
    api.download.mockResolvedValue(undefined);
    const first = render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/not signature-verified/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect(await screen.findByRole("button", { name: /Install UNSIGNED update/ })).toBeInTheDocument();
    first.unmount();

    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.3.0", availableCandidate: 3, keyInvalid: true, allowUnsigned: true });
    render(<UpdatesSection />);
    expect(await screen.findByText(/invalid update signing key/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(screen.queryByRole("switch", { name: /Allow unsigned updates/ })).not.toBeInTheDocument();
  });

  it("keeps Download usable after enabling unsigned once checked (backend keeps pending)", async () => {
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json" })
      .mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.2.0", availableCandidate: 7 });
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 7, generation: 0, pubDate: null });
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", allowUnsigned: true, availableVersion: "0.2.0", availableCandidate: 7 });
    api.download.mockResolvedValue(undefined);
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/Update 0\.2\.0 is available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Allow unsigned updates (I trust this feed)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    expect(screen.getByText(/Update 0\.2\.0 is available/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(api.download).toHaveBeenCalled());
  });

  it("keeps Ready after an auto-check toggle, and resets when the backend reports pendingReset", async () => {
    const feed = "https://example.com/u.json";
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: feed, allowUnsigned: true })
      .mockResolvedValueOnce({ ...base, feedUrl: feed, allowUnsigned: true, availableVersion: "0.2.0", availableCandidate: 3 });
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 3, generation: 0, pubDate: null });
    api.download.mockResolvedValue(undefined);
    api.setSettings.mockResolvedValueOnce({ ...base, feedUrl: feed, allowUnsigned: true, autoCheck: true, availableVersion: "0.2.0", availableCandidate: 3 });
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect(await screen.findByRole("button", { name: /Install UNSIGNED update/ })).toBeInTheDocument();
    // Safe non-feed change: stays Ready.
    fireEvent.click(screen.getByRole("switch", { name: /Check automatically on startup/ }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: /Install UNSIGNED update/ })).toBeInTheDocument();
    // Backend invalidated pending: back to the check state.
    api.setSettings.mockResolvedValueOnce({ ...base, feedUrl: feed, allowUnsigned: true, autoCheck: false, pendingReset: true });
    fireEvent.click(screen.getByRole("switch", { name: /Check automatically on startup/ }));
    expect(await screen.findByText(/Not checked yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install/ })).not.toBeInTheDocument();
  });

  it("ignores stale progress/ready events from another candidate", async () => {
    api.getSettings.mockResolvedValueOnce({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.2.0", availableCandidate: 5, allowUnsigned: true });
    render(<UpdatesSection />);
    expect(await screen.findByText(/Update 0\.2\.0 is available/)).toBeInTheDocument();
    act(() => emit({ kind: "progress", received: 5, total: 10, candidate: 4, generation: 0, operationId: "stale" }));
    act(() => emit({ kind: "ready", received: 10, total: 10, candidate: 4, generation: 0, operationId: "stale" }));
    expect(screen.getByText(/Update 0\.2\.0 is available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install/ })).not.toBeInTheDocument();
    api.download.mockImplementation(() => new Promise<void>(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const operationId = api.download.mock.calls.at(-1)![2];
    act(() => emit({ kind: "ready", received: 10, total: 10, candidate: 5, generation: 0, operationId: "stale" }));
    expect(screen.getByText(/Downloading update/)).toBeInTheDocument();
    act(() => emit({ kind: "ready", received: 10, total: 10, candidate: 5, generation: 0, operationId }));
    expect(await screen.findByRole("button", { name: /Install UNSIGNED update/ })).toBeInTheDocument();
    // After a reset, a late ready for the old candidate does not resurrect it.
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://other.example.com/u.json", keyConfigured: true, pendingReset: true });
    fireEvent.change(screen.getByLabelText("Update feed URL"), { target: { value: "https://other.example.com/u.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save feed" }));
    expect(await screen.findByText(/Not checked yet/)).toBeInTheDocument();
    act(() => emit({ kind: "ready", received: 10, total: 10, candidate: 5, generation: 0, operationId }));
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
  });

  it("rejects delayed availability after reset and rejects stale error events", async () => {
    const feed = "https://example.com/u.json";
    api.getSettings.mockResolvedValue({ ...base, feedUrl: feed });
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    let resolveSnapshot!: (value: UpdateSettings) => void;
    api.getSettings.mockImplementationOnce(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    act(() => emit({ kind: "available", received: 0, total: 10, version: "0.2.0", candidate: 9, generation: 0 }));
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://other.example.com/u.json", keyConfigured: true, generation: 1, pendingReset: true });
    fireEvent.change(screen.getByLabelText("Update feed URL"), { target: { value: "https://other.example.com/u.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save feed" }));
    await waitFor(() => expect(screen.getByText(/Not checked yet/)).toBeInTheDocument());
    resolveSnapshot({ ...base, feedUrl: feed, availableVersion: "0.2.0", availableCandidate: 9, generation: 0 });
    await act(async () => Promise.resolve());
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();

    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.3.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 10, generation: 1, pubDate: null });
    api.getSettings.mockResolvedValueOnce({ ...base, feedUrl: "https://other.example.com/u.json", keyConfigured: true, generation: 1, availableVersion: "0.3.0", availableCandidate: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByText(/Update 0\.3\.0 is available/);
    api.download.mockImplementation(() => new Promise<void>(() => undefined));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const operationId = api.download.mock.calls.at(-1)![2];
    act(() => emit({ kind: "error", received: 0, total: 0, message: "old failure", candidate: 10, generation: 1, operationId: "old-op" }));
    expect(screen.getByText(/Downloading update/)).toBeInTheDocument();
    act(() => emit({ kind: "error", received: 0, total: 0, message: "current failure", candidate: 10, generation: 1, operationId }));
    expect(await screen.findByText("current failure")).toBeInTheDocument();
  });

  it("retains valid badge until authoritative reset and ignores stale available events", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.2.0", availableCandidate: 4, generation: 2 });
    render(<UpdateBadge onOpen={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Update available" })).toBeInTheDocument();
    api.getSettings.mockResolvedValue({ ...base, generation: 3 });
    act(() => emit({ kind: "available", received: 0, total: 1, version: "0.2.0", candidate: 4, generation: 2 }));
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("button", { name: "Update available" })).not.toBeInTheDocument();
  });

  it("does not let a delayed initial badge snapshot overwrite a newer event snapshot", async () => {
    let resolveInitial!: (value: UpdateSettings) => void;
    api.getSettings
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ ...base, availableVersion: "0.2.0", availableCandidate: 4, generation: 2 });
    render(<UpdateBadge onOpen={() => undefined} />);
    act(() => emit({ kind: "available", received: 0, total: 1, version: "0.2.0", candidate: 4, generation: 2 }));
    expect(await screen.findByRole("button", { name: "Update available" })).toBeInTheDocument();
    resolveInitial({ ...base, generation: 1 });
    await act(async () => Promise.resolve());
    expect(screen.getByRole("button", { name: "Update available" })).toBeInTheDocument();
  });

  it("rejects delayed check responses after a feed-generation change", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json" });
    let finishCheck!: (value: UpdateCheckResult) => void;
    api.check.mockImplementation(() => new Promise((resolve) => { finishCheck = resolve; }));
    render(<UpdatesSection />);
    await screen.findByText(/Not checked yet/);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    api.setSettings.mockResolvedValue({ ...base, feedUrl: "https://other.example.com/u.json", generation: 1, pendingReset: true });
    fireEvent.change(screen.getByLabelText("Update feed URL"), { target: { value: "https://other.example.com/u.json" } });
    fireEvent.click(screen.getByRole("button", { name: "Save feed" }));
    await waitFor(() => expect(screen.getByText(/Not checked yet/)).toBeInTheDocument());
    finishCheck({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 7, generation: 0, pubDate: null });
    await act(async () => Promise.resolve());
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
  });

  it("rejects an expected candidate mismatch in updater IPC", async () => {
    const invoke = vi.mocked(invokeCore);
    invoke.mockResolvedValue(undefined as never);
    const { updateApi: actual } = await vi.importActual<typeof import("./update-api")>("./update-api");
    await actual.download(12, 4, "op-1");
    await actual.install(12);
    expect(invoke).toHaveBeenNthCalledWith(1, "update_download", { expectedCandidateId: 12, generation: 4, operationId: "op-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "update_install", { expectedCandidateId: 12 });
  });

  it("distinguishes key configured, signature verified, and unsigned explicitly allowed", async () => {
    const feed = "https://example.com/u.json";
    api.getSettings
      .mockResolvedValueOnce({ ...base, feedUrl: feed, keyConfigured: true, keyFingerprint: "0123456789abcdef" })
      .mockResolvedValueOnce({ ...base, feedUrl: feed, keyConfigured: true, keyFingerprint: "0123456789abcdef", availableVersion: "0.2.0", availableCandidate: 1 })
      .mockResolvedValueOnce({ ...base, feedUrl: feed, keyConfigured: true, keyFingerprint: "0123456789abcdef", availableVersion: "0.2.0", availableCandidate: 2 });
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: false, candidate: 1, generation: 0, pubDate: null });
    render(<UpdatesSection />);
    expect(await screen.findByText(/Signing key configured \(fingerprint: 0123456789abcdef\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByTestId("signature-state")).toHaveTextContent(/NOT verified/);
    api.check.mockResolvedValue({ current: "0.1.0", latest: "0.2.0", available: true, notes: "", size: 10, signatureVerified: true, candidate: 2, generation: 0, pubDate: null });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByTestId("signature-state")).toHaveTextContent(/Signature verified/));
  });

  it("restores an already-found update on open", async () => {
    api.getSettings.mockResolvedValue({ ...base, feedUrl: "https://example.com/u.json", availableVersion: "0.3.0", availableCandidate: 3 });
    render(<UpdatesSection />);
    expect(await screen.findByText(/Update 0\.3\.0 is available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });
});

describe("Update badge", () => {
  it("is hidden until an update is known, then opens settings", async () => {
    const open = vi.fn();
    render(<UpdateBadge onOpen={open} />);
    await waitFor(() => expect(api.onEvent).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Update available" })).not.toBeInTheDocument();
    api.getSettings.mockResolvedValueOnce({ ...base, availableVersion: "0.2.0", availableCandidate: 1 });
    emit({ kind: "available", received: 0, total: 1, version: "0.2.0", candidate: 1, generation: 0 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Update available" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Update available" }));
    expect(open).toHaveBeenCalled();
  });
});
