import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./agent-api", () => ({
  errorMessage: (cause: unknown) => String(cause),
  agentApi: { servicesStatus: vi.fn(), mediaList: vi.fn(), downloadStart: vi.fn(), downloadControl: vi.fn(), downloadReveal: vi.fn() },
}));
import { agentApi } from "./agent-api";
import { DownloadsPanel } from "./downloads-panel";
import type { AgentServicesStatus, MediaEntry } from "./types";

const jobs: AgentServicesStatus["downloads"]["jobs"] = [
  { job: { id: "run", status: "downloading", outputPath: null, error: null, errorCode: null, spec: { fileName: "movie.mp4" }, progress: { downloaded: 1048576, total: 2097152, speedBps: 524288, etaSecs: 2 } }, reauthorizationRequired: false },
  { job: { id: "paused", status: "paused", outputPath: null, error: null, errorCode: null }, reauthorizationRequired: false },
  { job: { id: "done", status: "completed", outputPath: "C:\\app\\downloads\\doc.pdf", error: null, errorCode: null }, reauthorizationRequired: false },
];
const status: AgentServicesStatus = {
  browser: { available: true, launchPolicy: "lazy_dedicated_disposable_profile", personalBrowser: false },
  computer: { available: true, capture: false, control: false, defaultDisabled: true },
  downloads: { available: true, destination: "C:\\app\\downloads", restoredJobsRequireReauthorization: true, jobs },
};
const entry = (patch: Partial<MediaEntry>): MediaEntry => ({
  id: "r1", url: "https://cdn.test/a.mp4?\u2026", name: "a.mp4", pageUrl: "https://page.test/", pageTitle: "Example page",
  kind: "video", mime: "video/mp4", size: 2048, drmProtected: false, timestamp: 1, ...patch,
});
const api = vi.mocked(agentApi);
beforeEach(() => {
  vi.clearAllMocks();
  api.servicesStatus.mockResolvedValue(status);
  api.mediaList.mockResolvedValue([entry({}), entry({ id: "r2", name: "secret.m3u8", kind: "hls", drmProtected: true, size: null })]);
  api.downloadStart.mockResolvedValue(jobs[0]!);
  api.downloadControl.mockResolvedValue(jobs[0]!);
  api.downloadReveal.mockResolvedValue(undefined);
});

describe("DownloadsPanel", () => {
  it("shows the ffmpeg hint when tracks were kept separate", async () => {
    api.servicesStatus.mockResolvedValue({ ...status, downloads: { ...status.downloads, jobs: [
      { job: { id: "m", status: "completed", outputPath: "C:\app\downloads\v.ts", error: null, errorCode: null }, reauthorizationRequired: false, muxSkipped: true, muxHint: "Tracks were kept as separate files. ffmpeg was not found." },
    ] } });
    render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/kept as separate files/)).toBeInTheDocument();
  });
  it("explains invalidRequest failures and offers no Resume for them", async () => {
    api.servicesStatus.mockResolvedValue({ ...status, downloads: { ...status.downloads, jobs: [
      { job: { id: "bad", status: "failed", outputPath: null, error: "Download failed; inspect errorCode.", errorCode: "invalidRequest" }, reauthorizationRequired: false },
      { job: { id: "net", status: "failed", outputPath: null, error: "Download failed; inspect errorCode.", errorCode: "network" }, reauthorizationRequired: false },
    ] } });
    render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText(/only public http\(s\) addresses are allowed/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
  });
  it("submits a pasted URL with an optional file name on Enter", async () => {
    render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
    const input = await screen.findByLabelText("Download URL");
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    fireEvent.change(input, { target: { value: " https://files.test/x.zip " } });
    fireEvent.change(screen.getByLabelText("File name (optional)"), { target: { value: "x.zip" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.downloadStart).toHaveBeenCalledWith("s", { url: "https://files.test/x.zip", fileName: "x.zip" }));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("lists detected media grouped by page and shows DRM rows as protected without a button", async () => {
    render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText("Example page")).toBeInTheDocument();
    expect(screen.getByText("a.mp4")).toBeInTheDocument();
    expect(screen.getByText("secret.m3u8")).toBeInTheDocument();
    expect(screen.getByText("Protected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download secret.m3u8" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download a.mp4" }));
    await waitFor(() => expect(api.downloadStart).toHaveBeenCalledWith("s", { capturedRequestId: "r1", kind: "http" }));
  });

  it("controls jobs, shows progress and reveals completed files", async () => {
    render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
    expect(await screen.findByText("movie.mp4")).toBeInTheDocument();
    expect(screen.getByText(/1\.0 MB \/ 2\.0 MB/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progress of movie.mp4" })).toHaveValue(50);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.downloadControl).toHaveBeenCalledWith("s", "run", "pause"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.downloadControl).toHaveBeenCalledWith("s", "paused", "resume"));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel download" })[0]!);
    await waitFor(() => expect(api.downloadControl).toHaveBeenCalledWith("s", "run", "cancel"));
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(api.downloadReveal).toHaveBeenCalledWith("s", "done"));
  });

  it("refreshes automatically while open", async () => {
    vi.useFakeTimers();
    try {
      render(<DownloadsPanel sessionId="s" onClose={vi.fn()} />);
      await vi.advanceTimersByTimeAsync(0);
      const first = api.mediaList.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3100);
      expect(api.mediaList.mock.calls.length).toBeGreaterThan(first);
    } finally { vi.useRealTimers(); }
  });
});
