import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCapturedBlobStreams } from "@/domain/omnia-ultra-downloader";
import {
  dispatchOmniaEnqueueDownloadEvent,
  UltraIdmDownloaderWorkbench,
} from "@/features/workspace/ultra-idm-downloader-workbench";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe("UltraIdmDownloaderWorkbench", () => {
  beforeEach(() => {
    clearCapturedBlobStreams();
    Object.defineProperty(window, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders Tab 1 (Active Queue & IDM Segment Map), enqueues URLs, performs Dynamic Work-Steal Split, and merges segments", () => {
    render(<UltraIdmDownloaderWorkbench />);

    expect(
      screen.getByRole("heading", {
        name: /Omnia Ultra IDM\+ Download Engine & Stream Grabber/i,
      }),
    ).toBeInTheDocument();

    // Verify initial job card and IDM Segment Progress Grid
    const firstJobCard = screen.getByTestId("idm-job-card-job-ultra-1");
    expect(within(firstJobCard).getByText("omnia-ai-runtime-v2.4-win64.zip")).toBeInTheDocument();
    expect(within(firstJobCard).getByText("Accept-Ranges: bytes")).toBeInTheDocument();
    expect(within(firstJobCard).getByText("8 Segments (0 Stolen)")).toBeInTheDocument();

    // Trigger Dynamic Work-Steal Split on job 1
    const splitBtn = within(firstJobCard).getByRole("button", {
      name: /Split Slowest Segment/i,
    });
    fireEvent.click(splitBtn);

    // Segment count increases from 8 to 9 with 1 stolen split
    expect(within(firstJobCard).getByText("9 Segments (1 Stolen)")).toBeInTheDocument();
    expect(within(firstJobCard).getAllByText(/stolen-split/i).length).toBeGreaterThanOrEqual(1);

    // Trigger Merge & Save File on job 1
    const mergeBtn = within(firstJobCard).getByRole("button", {
      name: /Merge & Save File/i,
    });
    fireEvent.click(mergeBtn);
    expect(within(firstJobCard).getByText(/Lossless Binary Merged \(ZIP\):/i)).toBeInTheDocument();

    // Enqueue a new URL via the quick input bar with 16 connections
    const urlInput = screen.getByLabelText(
      /Download URL, cURL, M3U8, MPD, or Blob stream input/i,
    );
    const connSelect = screen.getByLabelText(/Connection Count/i);
    fireEvent.change(connSelect, { target: { value: "16" } });
    fireEvent.change(urlInput, {
      target: { value: "https://cdn.omnia.local/models/llama-4-weights.safetensors.zip" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enqueue & Split Segments/i }));

    expect(screen.getByText("llama-4-weights.safetensors.zip")).toBeInTheDocument();
    expect(screen.getByText("16 Segments (0 Stolen)")).toBeInTheDocument();
  });

  it("renders Tab 2 (M3U8 / HLS / DASH / Blob Sniffer), parses 4K/1080p/720p variants, and reconstructs Blob/Data streams", () => {
    render(<UltraIdmDownloaderWorkbench />);

    fireEvent.click(
      screen.getByRole("tab", { name: /2\. M3U8 \/ HLS \/ DASH \/ Blob Sniffer/i }),
    );

    // Verify Master playlist variants are displayed (4K UHD, 1080p Full HD, 720p HD)
    expect(screen.getByText(/2160p \(4K UHD\)/i)).toBeInTheDocument();
    expect(screen.getByText(/1080p \(Full HD\)/i)).toBeInTheDocument();
    expect(screen.getByText(/720p \(HD\)/i)).toBeInTheDocument();

    // Switch to HLS Media + EXT-X-MAP + AES-128 preset
    fireEvent.click(
      screen.getByRole("button", { name: /Load HLS Media \+ EXT-X-MAP \+ AES-128/i }),
    );
    expect(screen.getByText(/#EXT-X-MAP Init Segment:/i)).toBeInTheDocument();
    expect(screen.getByText(/#EXT-X-KEY Encryption:/i)).toBeInTheDocument();

    // Test Blob & MSE Stream Reconstructor
    fireEvent.click(screen.getByRole("button", { name: /Append Captured Chunk/i }));
    fireEvent.click(screen.getByRole("button", { name: /Finalize & Save Stream/i }));

    const summary = screen.getByTestId("reconstructed-blob-summary");
    expect(within(summary).getByText(/MP4\/fMP4/i)).toBeInTheDocument();

    // Test Decode Data URL
    fireEvent.click(screen.getByRole("button", { name: /Decode Data URL/i }));
    expect(
      within(screen.getByTestId("reconstructed-blob-summary")).getAllByText(/PDF/i).length,
    ).toBeGreaterThanOrEqual(1);

    // Capture & Merge HLS stream into Active Queue
    const captureButtons = screen.getAllByRole("button", {
      name: /Capture & Merge Stream to \.MP4 \/ \.TS/i,
    });
    fireEvent.click(captureButtons[0]!);

    // Should switch back to Active Queue with captured stream job
    expect(screen.getByText("stream-hls-media-vod.mp4")).toBeInTheDocument();
  });

  it("renders Tab 3 (cURL Studio), Tab 4 (Batch Site Grabber), and Tab 5 (Lossless Binary Merger & SHA-256)", () => {
    render(<UltraIdmDownloaderWorkbench />);

    // Tab 3: cURL Studio
    fireEvent.click(
      screen.getByRole("tab", { name: /3\. cURL \/ Header \/ Cookie Studio/i }),
    );
    expect(
      screen.getAllByText(/model-weights-fp16\.safetensors\.zip/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText(/Bearer sovereign-api-key-2026/i).length,
    ).toBeGreaterThanOrEqual(1);
    fireEvent.click(
      screen.getByRole("button", { name: /Queue Segmented Download from cURL\/Fetch/i }),
    );
    expect(
      screen.getAllByText("model-weights-fp16.safetensors.zip").length,
    ).toBeGreaterThanOrEqual(1);

    // Tab 4: Batch Site Grabber
    fireEvent.click(
      screen.getByRole("tab", { name: /4\. Batch Site Grabber \[001-100\]/i }),
    );
    expect(screen.getByText("shard-001.zip")).toBeInTheDocument();
    expect(screen.getByText("shard-008.zip")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Queue Selected Batch Items \(8\)/i }),
    );
    expect(screen.getByText("shard-001.zip")).toBeInTheDocument();

    // Tab 5: Lossless Binary Merger & SHA-256 Verifier
    fireEvent.click(
      screen.getByRole("tab", { name: /5\. Lossless Binary Merger & SHA-256/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Run Lossless Binary Merge & Verify SHA-256/i }),
    );
    const mergeCard = screen.getByTestId("binary-merge-result-card");
    expect(
      within(mergeCard).getByText(/Contiguous Binary Merge Verified/i),
    ).toBeInTheDocument();
    expect(within(mergeCard).getAllByText(/MP4\/fMP4/i).length).toBeGreaterThanOrEqual(1);
  });

  it("listens to global omnia:enqueue-download custom events from Sovereign Browser F12 Network tab", () => {
    render(<UltraIdmDownloaderWorkbench initialTab="sniffer" />);

    act(() => {
      dispatchOmniaEnqueueDownloadEvent({
        url: "https://edge.omnia.local/streams/f12-captured-4k.m3u8",
        filename: "f12-captured-4k.mp4",
        maxConnections: 8,
        isStreamManifest: true,
      });
    });

    // Automatically switches to Active Queue and displays the newly enqueued F12 stream
    expect(screen.getByText("f12-captured-4k.mp4")).toBeInTheDocument();
  });

  it("executes real network HTTP byte-range and HLS (.m3u8) fetch, merges real Uint8Array segments, saves Blob file to disk, and persists queue to localStorage", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes(".m3u8") || url.includes("keynote-2160p-uhd")) {
        const playlist = [
          "#EXTM3U",
          "#EXT-X-VERSION:7",
          "#EXT-X-TARGETDURATION:4",
          '#EXT-X-MAP:URI="init-live.mp4"',
          "#EXTINF:4.000,",
          "seg-live-0.m4s",
          "#EXTINF:4.000,",
          "seg-live-1.m4s",
          "#EXT-X-ENDLIST",
        ].join("\n");
        return new Response(playlist, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (url.includes("init-live.mp4")) {
        const mp4Header = new Uint8Array([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
        ]);
        return new Response(mp4Header, { status: 200 });
      }
      if (url.includes("seg-live-")) {
        const segBytes = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
        return new Response(segBytes, { status: 200 });
      }
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "64",
            "accept-ranges": "bytes",
          },
        });
      }
      // Byte-range GET response with ZIP magic bytes
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x0b, 0x0c, 0x0d]);
      return new Response(zipBytes, {
        status: 206,
        headers: {
          "content-range": "bytes 0-7/64",
          "accept-ranges": "bytes",
        },
      });
    });

    const createObjectUrlSpy = vi.fn(
      () => "blob:https://omnia.local/real-merged-artifact",
    );
    const revokeObjectUrlSpy = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectUrlSpy,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectUrlSpy,
      configurable: true,
      writable: true,
    });
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<UltraIdmDownloaderWorkbench />);

    // Verify localStorage persistence of initial queue
    expect(window.localStorage.getItem("omnia.ultra.idm.jobs.v1")).toBeTruthy();

    // 1. Trigger Live Network Fetch on job-ultra-1 (HTTP Byte-Range ZIP job)
    const liveFetchBtn1 = screen.getByTestId("live-network-download-btn-job-ultra-1");
    fireEvent.click(liveFetchBtn1);

    const firstJobCard = screen.getByTestId("idm-job-card-job-ultra-1");
    await waitFor(() => {
      expect(
        within(firstJobCard).getByText(/Lossless Binary Merged \(ZIP\):/i),
      ).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalled();

    // Save merged file to disk via Blob & <a download>
    const saveDiskBtn = within(firstJobCard).getByTestId("save-merged-file-to-disk-btn");
    fireEvent.click(saveDiskBtn);
    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(anchorClickSpy).toHaveBeenCalled();

    // 2. Trigger Live Network Fetch on job-ultra-2 (HLS .m3u8 + #EXT-X-MAP MP4 stream job)
    const liveFetchBtn2 = screen.getByTestId("live-network-download-btn-job-ultra-2");
    fireEvent.click(liveFetchBtn2);

    const secondJobCard = screen.getByTestId("idm-job-card-job-ultra-2");
    await waitFor(() => {
      expect(
        within(secondJobCard).getByText(/Lossless Binary Merged \(MP4\/fMP4\):/i),
      ).toBeInTheDocument();
    });

    // 3. Switch to Tab 2 and test Fetch Live URL for HLS manifest
    fireEvent.click(
      screen.getByRole("tab", { name: /2\. M3U8 \/ HLS \/ DASH \/ Blob Sniffer/i }),
    );
    const manifestUrlInput = screen.getByLabelText(/Manifest or Page Base URL/i);
    fireEvent.change(manifestUrlInput, {
      target: { value: "https://cdn.example.com/live/master-live.m3u8" },
    });
    fireEvent.click(screen.getByTestId("fetch-live-manifest-btn"));

    await waitFor(() => {
      expect(screen.getAllByText(/init-live\.mp4/i).length).toBeGreaterThanOrEqual(1);
    });

    anchorClickSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("customizes Lookahead Buffer & Human-Seek Pacing settings and resolves Google Drive / OneDrive links + reconstructs 1200 DPI %PDF-1.7 in Tab 6", () => {
    render(<UltraIdmDownloaderWorkbench />);

    // Verify Lookahead Buffer & Advanced Pacing Settings panel in Active Queue
    const pacingPanel = screen.getByTestId("lookahead-pacing-settings-panel");
    expect(
      within(pacingPanel).getByTestId("lookahead-schedule-summary"),
    ).toHaveTextContent(/1h \(3600s\) video finishes in 6:00 \(10x speedup/i);

    // Customize Seek Speed Multiplier to 20x -> 1h video finishes in 3:00 (180s)
    const multiplierInput = within(pacingPanel).getByTestId("seek-multiplier-input");
    fireEvent.change(multiplierInput, { target: { value: "20" } });
    expect(
      within(pacingPanel).getByTestId("lookahead-schedule-summary"),
    ).toHaveTextContent(/1h \(3600s\) video finishes in 3:00 \(20x speedup/i);

    // Switch to Tab 6: Cloud Drive & Ultra-DPI PDF
    fireEvent.click(
      screen.getByRole("tab", { name: /Cloud Drive & Ultra-DPI PDF/i }),
    );

    const cloudUrlInput = screen.getByTestId("cloud-media-url-input");
    fireEvent.change(cloudUrlInput, {
      target: {
        value: "https://drive.google.com/file/d/1SovereignDrive4KMaster/view?usp=sharing",
      },
    });
    fireEvent.click(screen.getByTestId("resolve-cloud-link-btn"));

    const resolutionCard = screen.getByTestId("cloud-resolution-result-card");
    expect(within(resolutionCard).getByText("google-drive")).toBeInTheDocument();
    expect(within(resolutionCard).getByText("1SovereignDrive4KMaster")).toBeInTheDocument();

    // Select 1200 DPI and reconstruct Ultra-High-DPI PDF
    const dpiSelect = screen.getByTestId("pdf-dpi-select");
    fireEvent.change(dpiSelect, { target: { value: "1200" } });
    fireEvent.click(screen.getByTestId("reconstruct-high-dpi-pdf-btn"));

    const pdfCard = screen.getByTestId("high-dpi-pdf-result-card");
    expect(within(pdfCard).getAllByText(/1200 DPI/i).length).toBeGreaterThanOrEqual(1);
    expect(within(pdfCard).getByText(/9921x14031 px/i)).toBeInTheDocument();

    // Queue Selected Stream in IDM+ and verify it switches to Active Queue with the stream job
    fireEvent.click(screen.getByTestId("queue-cloud-stream-btn"));
    expect(
      screen.getAllByText(/gdrive-1SovereignDrive4KMaster-4k-2160p\.mp4/i).length,
    ).toBeGreaterThanOrEqual(1);

    // Verify DevTools progressive-disclosure classes, segmented ribbon, and 24px statusbar
    expect(screen.getByTestId("idm-segment-ribbon-job-ultra-1")).toBeInTheDocument();
    const statusBar = screen.getByTestId("ultra-idm-statusbar");
    expect(statusBar).toHaveClass("sw-statusbar");
    expect(statusBar).toHaveTextContent(/Engine: Rust \+ Web Fetch Range\/HLS/i);
  });
});
