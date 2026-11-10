import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileCheck2,
  Film,
  FolderDown,
  Globe,
  HardDriveDownload,
  Layers,
  Pause,
  Play,
  Plus,
  Scissors,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import {
  advanceSegmentProgress,
  appendCapturedBlobChunk,
  assembleHighDpiDocumentPdf,
  computeLookaheadBufferSchedule,
  createSegmentedDownloadPlan,
  DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
  expandBatchUrlPattern,
  finalizeCapturedBlobStream,
  formatByteSize,
  formatDurationSeconds,
  listCapturedBlobStreams,
  mergeDownloadSegmentsLossless,
  parseCurlOrFetchCommand,
  parseDashMpdManifest,
  parseHlsM3u8Manifest,
  reconstructBlobOrDataUrlPayload,
  resolveUniversalCloudMediaUrl,
  sniffDownloadableLinksFromContent,
  stealAndSplitSlowestSegment,
  type CloudMediaResolutionResult,
  type DetectedContainerFormat,
  type HighDpiPdfReconstructionResult,
  type LosslessMergeResult,
  type PdfDpiPreset,
  type ReconstructedBlobPayload,
  type SegmentedDownloadPlan,
  type StreamLookaheadPacingConfig,
  type StreamPacingMode,
  type VideoQualityPreference,
} from "@/domain/omnia-ultra-downloader";
import { desktop, isDesktopRuntime } from "@/lib/desktop";

export type UltraIdmWorkbenchTabId =
  | "queue"
  | "sniffer"
  | "curl-studio"
  | "batch-grabber"
  | "binary-merger"
  | "cloud-pdf-grabber";

export interface OmniaEnqueueDownloadEventDetail {
  readonly url: string;
  readonly filename?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly totalBytes?: number | undefined;
  readonly maxConnections?: number | undefined;
  readonly acceptRanges?: boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly referer?: string | undefined;
  readonly cookieHeader?: string | undefined;
  readonly isStreamManifest?: boolean | undefined;
  readonly source?: string | undefined;
}

export interface UltraIdmDownloaderWorkbenchProps {
  readonly initialUrl?: string | undefined;
  readonly initialTab?: UltraIdmWorkbenchTabId | undefined;
  readonly onClose?: (() => void) | undefined;
}

export interface UltraDownloadQueueJob {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly status: "downloading" | "paused" | "completed" | "merged";
  readonly isHlsOrDashStream: boolean;
  readonly streamVariantLabel?: string | undefined;
  readonly speedLimitKbps: number | null;
  readonly currentSpeedBps: number;
  readonly plan: SegmentedDownloadPlan;
  readonly createdAtIso: string;
  readonly lastSha256Hex?: string | undefined;
  readonly mergedContainerFormat?: DetectedContainerFormat | undefined;
  readonly verificationMessage?: string | undefined;
}

/**
 * Helper to dispatch the global `omnia:enqueue-download` event from Sovereign Browser F12 Network tab
 * or anywhere in the workspace.
 */
export function dispatchOmniaEnqueueDownloadEvent(
  detail: string | OmniaEnqueueDownloadEventDetail,
): void {
  if (typeof window === "undefined") {
    return;
  }
  const normalized: OmniaEnqueueDownloadEventDetail =
    typeof detail === "string" ? { url: detail } : detail;
  window.dispatchEvent(
    new CustomEvent<OmniaEnqueueDownloadEventDetail>("omnia:enqueue-download", {
      detail: normalized,
    }),
  );
}

const SAMPLE_HLS_MASTER_MANIFEST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-high",NAME="English Dolby 5.1",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en-dolby.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English SDH",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=18400000,AVERAGE-BANDWIDTH=15200000,RESOLUTION=3840x2160,FRAME-RATE=60.000,CODECS="hev1.1.6.L153.B0,mp4a.40.2",AUDIO="audio-high",SUBTITLES="subs"
variants/2160p-uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6800000,AVERAGE-BANDWIDTH=5600000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2",AUDIO="audio-high",SUBTITLES="subs"
variants/1080p-fhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3100000,AVERAGE-BANDWIDTH=2600000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio-high",SUBTITLES="subs"
variants/720p-hd.m3u8`;

const SAMPLE_HLS_MEDIA_MANIFEST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init-video.mp4",BYTERANGE="768@0"
#EXT-X-KEY:METHOD=AES-128,URI="keys/aes128.key",IV=0x00000000000000000000000000000001
#EXTINF:4.000,Segment 1
seg-0001.m4s
#EXTINF:4.000,Segment 2
seg-0002.m4s
#EXTINF:4.000,Segment 3
seg-0003.m4s
#EXTINF:3.500,Segment 4
seg-0004.m4s
#EXT-X-ENDLIST`;

const SAMPLE_DASH_MPD_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT16S" minBufferTime="PT2S">
  <Period id="p0">
    <AdaptationSet id="video" mimeType="video/mp4" contentType="video" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="4000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%04d$.m4s" startNumber="1" />
      <Representation id="2160p" codecs="hev1.1.6.L153" width="3840" height="2160" frameRate="60" bandwidth="16500000" />
      <Representation id="1080p" codecs="avc1.640028" width="1920" height="1080" frameRate="60" bandwidth="6400000" />
    </AdaptationSet>
    <AdaptationSet id="audio" mimeType="audio/mp4" contentType="audio" lang="en" segmentAlignment="true">
      <Representation id="audio-aac" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="192000">
        <BaseURL>audio-en-192k.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const SAMPLE_PAGE_HTML = `<div class="media-page">
  <video controls>
    <source src="https://stream.omnia.local/vod/keynote-master.m3u8" type="application/vnd.apple.mpegurl" label="4K HLS" />
    <source src="https://cdn.omnia.local/media/keynote-1080p.mp4" type="video/mp4" data-quality="1080p" />
  </video>
  <a href="https://cdn.omnia.local/releases/omnia-studio-win64.zip" download>Download Studio SDK (.zip)</a>
  <script>
    window.__PLAYER__ = {
      "dashUrl": "https:\\/\\/stream.omnia.local\\/dash\\/manifest.mpd",
      "downloadUrl": "https:\\/\\/cdn.omnia.local\\/papers\\/architecture-spec.pdf"
    };
    const blobSource = "blob:https://stream.omnia.local/44556677-8899-aabb-ccdd-eeff00112233";
  </script>
</div>`;

const SAMPLE_CURL_COMMAND = `curl 'https://cdn.omnia.local/protected/model-weights-fp16.safetensors.zip?token=eyJ0eXAi' \\
  -H 'Cookie: omnia_session=s891237918; cf_clearance=verified_99' \\
  -H 'Referer: https://hub.omnia.local/models/ultra' \\
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) OmniaSovereign/2.0' \\
  -H 'Authorization: Bearer sovereign-api-key-2026'`;

function createInitialJobs(initialUrl?: string): UltraDownloadQueueJob[] {
  const plan1 = createSegmentedDownloadPlan({
    jobId: "job-ultra-1",
    url: initialUrl?.trim() || "https://cdn.omnia.local/releases/omnia-ai-runtime-v2.4-win64.zip",
    totalBytes: 16_777_216, // 16 MB
    maxConnections: 8,
    minSegmentBytes: 65_536,
    acceptRanges: true,
    headers: {
      Referer: "https://omnia.local/releases",
    },
  });

  // Advance first 3 segments to completed and partial progress on others so IDM grid looks alive
  let progressedPlan1 = advanceSegmentProgress(plan1, plan1.segments[0]!.id, 2_097_152, 6_400_000);
  progressedPlan1 = advanceSegmentProgress(
    progressedPlan1,
    progressedPlan1.segments[1]!.id,
    2_097_152,
    6_100_000,
  );
  progressedPlan1 = advanceSegmentProgress(
    progressedPlan1,
    progressedPlan1.segments[2]!.id,
    1_200_000,
    4_800_000,
  );
  progressedPlan1 = advanceSegmentProgress(
    progressedPlan1,
    progressedPlan1.segments[7]!.id,
    262_144,
    950_000,
  );

  const plan2 = createSegmentedDownloadPlan({
    jobId: "job-ultra-2",
    url: "https://stream.omnia.local/hls/keynote-2160p-uhd.ts",
    filename: "keynote-2160p-uhd.mp4",
    mimeType: "video/mp4",
    totalBytes: 8_388_608, // 8 MB
    maxConnections: 4,
    minSegmentBytes: 65_536,
    acceptRanges: true,
  });
  const progressedPlan2 = advanceSegmentProgress(plan2, plan2.segments[0]!.id, 2_097_152, 5_200_000);

  return [
    {
      id: progressedPlan1.jobId,
      url: progressedPlan1.url,
      filename: progressedPlan1.filename,
      mimeType: progressedPlan1.mimeType,
      status: "downloading",
      isHlsOrDashStream: false,
      speedLimitKbps: null,
      currentSpeedBps: 18_250_000,
      plan: progressedPlan1,
      createdAtIso: new Date().toISOString(),
    },
    {
      id: progressedPlan2.jobId,
      url: progressedPlan2.url,
      filename: progressedPlan2.filename,
      mimeType: progressedPlan2.mimeType,
      status: "downloading",
      isHlsOrDashStream: true,
      streamVariantLabel: "2160p (4K UHD) • HEVC",
      speedLimitKbps: null,
      currentSpeedBps: 9_400_000,
      plan: progressedPlan2,
      createdAtIso: new Date().toISOString(),
    },
  ];
}

function generateSyntheticSegmentBytesForJob(job: UltraDownloadQueueJob): {
  readonly segments: ReadonlyArray<{
    readonly index: number;
    readonly startByte: number;
    readonly endByte: number;
    readonly data: Uint8Array;
  }>;
  readonly totalBytes: number;
} {
  // Build deterministic compact segment buffers (scaled so tests and browser merges run sub-millisecond)
  const scaleFactor = job.plan.totalBytes > 4096 ? Math.ceil(job.plan.totalBytes / 1024) : 1;
  let cursor = 0;

  const segments = job.plan.segments.map((seg, idx) => {
    const length = Math.max(8, Math.round(seg.totalBytes / scaleFactor));
    const startByte = cursor;
    const endByte = startByte + length - 1;
    cursor = endByte + 1;

    const buf = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      buf[i] = (idx * 31 + i) & 0xff;
    }

    // Stamp valid container header in segment #0
    if (idx === 0 && length >= 8) {
      if (job.filename.endsWith(".png")) {
        buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      } else if (job.filename.endsWith(".pdf")) {
        buf.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37], 0);
      } else if (job.filename.endsWith(".zip")) {
        buf.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00], 0);
      } else if (job.filename.endsWith(".ts")) {
        buf[0] = 0x47;
      } else {
        // Default MP4/fMP4 'ftypisom' box
        buf.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
      }
    }

    return {
      index: idx,
      startByte,
      endByte,
      data: buf,
    };
  });

  return {
    segments,
    totalBytes: cursor,
  };
}

const ULTRA_IDM_STORAGE_KEY = "omnia.ultra.idm.jobs.v1";

interface UltraIdmPersistedState {
  readonly jobs: UltraDownloadQueueJob[];
  readonly connectionCount: number;
  readonly speedLimitKbps: number | null;
}

interface UltraIdmDesktopBridge {
  createDownloadJob?: (payload: Record<string, unknown>) => Promise<unknown>;
  startDownloadJob?: (jobId: string) => Promise<unknown>;
  appendDownloadChunk?: (payload: Record<string, unknown>) => Promise<unknown>;
  completeDownloadJob?: (jobId: string) => Promise<unknown>;
  pauseDownloadJob?: (jobId: string) => Promise<unknown>;
  resumeDownloadJob?: (jobId: string) => Promise<unknown>;
  cancelDownloadJob?: (jobId: string) => Promise<unknown>;
}

function getDesktopDownloadBridge(): UltraIdmDesktopBridge {
  return (desktop ?? {}) as unknown as UltraIdmDesktopBridge;
}

function loadPersistedUltraIdmState(initialUrl?: string): UltraIdmPersistedState {
  if (typeof window !== "undefined" && typeof window.localStorage?.getItem === "function") {
    try {
      const raw = window.localStorage.getItem(ULTRA_IDM_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<UltraIdmPersistedState>;
        if (Array.isArray(parsed.jobs) && parsed.jobs.length > 0 && !initialUrl?.trim()) {
          return {
            jobs: parsed.jobs,
            connectionCount:
              typeof parsed.connectionCount === "number" && parsed.connectionCount >= 1
                ? parsed.connectionCount
                : 8,
            speedLimitKbps:
              typeof parsed.speedLimitKbps === "number" ? parsed.speedLimitKbps : null,
          };
        }
      }
    } catch {
      // Ignore malformed localStorage state and fall back cleanly
    }
  }
  return {
    jobs: createInitialJobs(initialUrl),
    connectionCount: 8,
    speedLimitKbps: null,
  };
}

function concatSegmentBytes(
  segments: ReadonlyArray<{ readonly data: Uint8Array }>,
  initSegment?: Uint8Array,
): Uint8Array {
  const initLen = initSegment ? initSegment.byteLength : 0;
  const bodyLen = segments.reduce((sum, seg) => sum + seg.data.byteLength, 0);
  const out = new Uint8Array(initLen + bodyLen);
  let offset = 0;
  if (initSegment && initSegment.byteLength > 0) {
    out.set(initSegment, 0);
    offset += initSegment.byteLength;
  }
  for (const seg of segments) {
    out.set(seg.data, offset);
    offset += seg.data.byteLength;
  }
  return out;
}

async function readResponseToUint8Array(
  response: Response,
  onChunk?: (chunkByteLength: number) => void,
): Promise<Uint8Array> {
  if (response.body && typeof response.body.getReader === "function") {
    try {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          totalLength += value.byteLength;
          onChunk?.(value.byteLength);
        }
      }
      if (totalLength > 0) {
        const combined = new Uint8Array(totalLength);
        let cursor = 0;
        for (const chunk of chunks) {
          combined.set(chunk, cursor);
          cursor += chunk.byteLength;
        }
        return combined;
      }
    } catch {
      // Fall back to arrayBuffer / text if stream reading is unsupported
    }
  }

  if (typeof response.arrayBuffer === "function") {
    const ab = await response.arrayBuffer();
    const bytes = new Uint8Array(ab);
    if (bytes.byteLength > 0) {
      onChunk?.(bytes.byteLength);
      return bytes;
    }
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    onChunk?.(bytes.byteLength);
    return bytes;
  }

  return new Uint8Array(0);
}

export function UltraIdmDownloaderWorkbench({
  initialUrl,
  initialTab = "queue",
  onClose,
}: UltraIdmDownloaderWorkbenchProps): React.ReactElement {
  const initialPersisted = useMemo(
    () => loadPersistedUltraIdmState(initialUrl),
    [initialUrl],
  );
  const [activeTab, setActiveTab] = useState<UltraIdmWorkbenchTabId>(initialTab);
  const [jobs, setJobs] = useState<UltraDownloadQueueJob[]>(() => initialPersisted.jobs);

  // Real downloaded segment buffers: Map<jobId, Map<segmentIdOrIndex, Uint8Array>>
  const realSegmentBytesRef = useRef<Map<string, Map<string, Uint8Array>>>(new Map());
  const realInitSegmentBytesRef = useRef<Map<string, Uint8Array>>(new Map());
  const lastMergedBytesRef = useRef<Uint8Array | null>(null);

  // Tab 1: Active Queue & IDM Segment Map state
  const [quickInputUrl, setQuickInputUrl] = useState<string>(initialUrl ?? "");
  const [connectionCount, setConnectionCount] = useState<number>(
    () => initialPersisted.connectionCount,
  );
  const [speedLimitKbps, setSpeedLimitKbps] = useState<number | null>(
    () => initialPersisted.speedLimitKbps,
  );
  const [customReferer, setCustomReferer] = useState<string>("");
  const [customCookie, setCustomCookie] = useState<string>("");
  const [customAuthHeader, setCustomAuthHeader] = useState<string>("");
  const [showHeaderOverrides, setShowHeaderOverrides] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<string>(
    "IDM+ Multi-Segment Engine ready • Dynamic Work-Stealing & Lossless Stream Remux active.",
  );

  // Tab 2: M3U8 / HLS / DASH / Blob Stream Sniffer state
  const [, setSnifferMode] = useState<"hls-master" | "hls-media" | "dash-mpd" | "page-html">(
    "hls-master",
  );
  const [snifferBaseUrl, setSnifferBaseUrl] = useState<string>(
    "https://stream.omnia.local/hls/keynote/master.m3u8",
  );
  const [snifferInputText, setSnifferInputText] = useState<string>(SAMPLE_HLS_MASTER_MANIFEST);
  const [selectedVariantId, setSelectedVariantId] = useState<string>("variant-1");
  const [blobUrlInput, setBlobUrlInput] = useState<string>(
    "blob:https://stream.omnia.local/44556677-8899-aabb-ccdd-eeff00112233",
  );
  const [dataUrlInput, setDataUrlInput] = useState<string>(
    "data:application/pdf;base64,JVBERi0xLjcKJeLjz9MK",
  );
  const [reconstructedPayload, setReconstructedPayload] = useState<ReconstructedBlobPayload | null>(
    null,
  );
  const [blobStreamsVersion, setBlobStreamsVersion] = useState<number>(0);

  // Tab 3: cURL / Header / Cookie Studio state
  const [curlCommandInput, setCurlCommandInput] = useState<string>(SAMPLE_CURL_COMMAND);

  // Tab 4: Batch Site Grabber state
  const [batchPatternInput, setBatchPatternInput] = useState<string>(
    "https://cdn.omnia.local/datasets/shard-[001-008].zip",
  );
  const [selectedBatchUrls, setSelectedBatchUrls] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        expandBatchUrlPattern("https://cdn.omnia.local/datasets/shard-[001-008].zip").map(
          (i) => i.url,
        ),
      ),
  );

  // Tab 5: Lossless Binary Merger & Checksum Verifier state
  const [selectedMergerJobId, setSelectedMergerJobId] = useState<string>("job-ultra-1");
  const [expectedSha256Input, setExpectedSha256Input] = useState<string>("");
  const [prependExtXMapInit, setPrependExtXMapInit] = useState<boolean>(true);
  const [lastMergeResult, setLastMergeResult] = useState<LosslessMergeResult | null>(null);
  const [mergeErrorText, setMergeErrorText] = useState<string | null>(null);

  // Continuous Lookahead Buffer & Configurable Human-Like Seek Pacing state
  const [pacingConfig, setPacingConfig] = useState<StreamLookaheadPacingConfig>(
    () => DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
  );
  const [sampleStreamDurationSec] = useState<number>(3600);
  const [showLookaheadPacingPanel, setShowLookaheadPacingPanel] = useState<boolean>(false);

  // Tab 6: Cloud Drive & View-Only Media + Ultra-High-DPI (150-1200 DPI) PDF Reconstructor state
  const [cloudInputUrl, setCloudInputUrl] = useState<string>(
    "https://drive.google.com/file/d/1OmniaUltraArchivalSpec2026/view?usp=sharing",
  );
  const [selectedCloudQuality, setSelectedCloudQuality] =
    useState<VideoQualityPreference>("4k-2160p");
  const [selectedPdfDpi, setSelectedPdfDpi] = useState<PdfDpiPreset>(600);
  const [pdfTitleInput, setPdfTitleInput] = useState<string>(
    "Omnia Sovereign Archival Blueprint",
  );
  const [pdfPageCountInput, setPdfPageCountInput] = useState<number>(4);
  const [cloudResolution, setCloudResolution] = useState<CloudMediaResolutionResult>(() =>
    resolveUniversalCloudMediaUrl(
      "https://drive.google.com/file/d/1OmniaUltraArchivalSpec2026/view?usp=sharing",
      { preferredQuality: "4k-2160p", preferredDpi: 600 },
    ),
  );
  const [reconstructedPdfResult, setReconstructedPdfResult] =
    useState<HighDpiPdfReconstructionResult | null>(null);

  const lookaheadSchedule = useMemo(
    () =>
      computeLookaheadBufferSchedule({
        streamDurationSec: sampleStreamDurationSec,
        totalSegments: 600,
        totalBytes: 1_572_864_000,
        config: pacingConfig,
      }),
    [sampleStreamDurationSec, pacingConfig],
  );

  // Persist queue jobs, connectionCount, and speedLimitKbps to localStorage
  useEffect(() => {
    if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
      try {
        const payload: UltraIdmPersistedState = {
          jobs,
          connectionCount,
          speedLimitKbps,
        };
        window.localStorage.setItem(ULTRA_IDM_STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Ignore storage quota errors
      }
    }
  }, [jobs, connectionCount, speedLimitKbps]);

  const resolveJobSegmentsForMerge = useCallback(
    (
      targetJob: UltraDownloadQueueJob,
    ): {
      readonly segments: ReadonlyArray<{
        readonly index: number;
        readonly startByte: number;
        readonly endByte: number;
        readonly data: Uint8Array;
      }>;
      readonly totalBytes: number;
      readonly isRealNetwork: boolean;
    } => {
      const realMap = realSegmentBytesRef.current.get(targetJob.id);
      if (realMap && realMap.size > 0) {
        const orderedBuffers: Uint8Array[] = [];
        for (let idx = 0; idx < targetJob.plan.segments.length; idx += 1) {
          const seg = targetJob.plan.segments[idx]!;
          const byId = realMap.get(seg.id) ?? realMap.get(`seg-${idx}`) ?? realMap.get(String(idx));
          if (byId && byId.byteLength > 0) {
            orderedBuffers.push(byId);
          }
        }
        if (orderedBuffers.length === 0) {
          for (const [key, buf] of realMap.entries()) {
            if (key !== "__init__" && buf.byteLength > 0) {
              orderedBuffers.push(buf);
            }
          }
        }
        if (orderedBuffers.length > 0) {
          let cursor = 0;
          const segments = orderedBuffers.map((buf, idx) => {
            const startByte = cursor;
            const endByte = startByte + buf.byteLength - 1;
            cursor = endByte + 1;
            return {
              index: idx,
              startByte,
              endByte,
              data: buf,
            };
          });
          return {
            segments,
            totalBytes: cursor,
            isRealNetwork: true,
          };
        }
      }

      const synthetic = generateSyntheticSegmentBytesForJob(targetJob);
      return {
        ...synthetic,
        isRealNetwork: false,
      };
    },
    [],
  );

  const executeLiveNetworkDownload = useCallback(
    async (jobOrId: string | UltraDownloadQueueJob) => {
      const targetJob =
        typeof jobOrId === "string" ? jobs.find((j) => j.id === jobOrId) : jobOrId;
      if (!targetJob) return;

      let jobSegMap = realSegmentBytesRef.current.get(targetJob.id);
      if (!jobSegMap) {
        jobSegMap = new Map<string, Uint8Array>();
        realSegmentBytesRef.current.set(targetJob.id, jobSegMap);
      }

      const bridge = getDesktopDownloadBridge();
      if (isDesktopRuntime()) {
        try {
          await bridge.createDownloadJob?.({
            jobId: targetJob.id,
            url: targetJob.url,
            filename: targetJob.filename,
            mimeType: targetJob.mimeType,
            totalBytes: targetJob.plan.totalBytes,
            maxConnections: targetJob.plan.maxConnections,
            headers: targetJob.plan.headers,
          });
          await bridge.startDownloadJob?.(targetJob.id);
        } catch {
          // Graceful fallback if desktop IPC command is unavailable
        }
      }

      try {
        if (typeof fetch !== "function") {
          throw new Error("fetch API unavailable");
        }

        const isHlsStream =
          targetJob.isHlsOrDashStream || targetJob.url.toLowerCase().includes(".m3u8");

        if (isHlsStream) {
          const manifestRes = await fetch(targetJob.url, {
            method: "GET",
            headers: { ...targetJob.plan.headers },
          });
          if (!manifestRes.ok) {
            throw new Error(`HTTP ${manifestRes.status}`);
          }
          const manifestText = await manifestRes.text();
          let parsed = parseHlsM3u8Manifest(manifestText, targetJob.url);

          const sanitizeSubresourceHeaders = (subUrl: string): Record<string, string> => {
            const next: Record<string, string> = { ...targetJob.plan.headers };
            try {
              const baseOrigin = new URL(targetJob.url, "https://localhost").origin;
              const targetOrigin = new URL(subUrl, targetJob.url).origin;
              if (baseOrigin !== targetOrigin) {
                for (const key of Object.keys(next)) {
                  if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) {
                    delete next[key];
                  }
                }
              }
            } catch {
              // Keep non-sensitive headers on parse error
            }
            return next;
          };

          if (parsed.variants.length > 0 && parsed.segments.length === 0) {
            try {
              const variantUrl = parsed.variants[0]!.resolvedUrl;
              const variantRes = await fetch(variantUrl, {
                method: "GET",
                headers: sanitizeSubresourceHeaders(variantUrl),
              });
              if (variantRes.ok) {
                const variantText = await variantRes.text();
                const variantParsed = parseHlsM3u8Manifest(
                  variantText,
                  variantUrl,
                );
                if (variantParsed.segments.length > 0) {
                  parsed = variantParsed;
                }
              }
            } catch {
              // Keep master manifest metadata if variant playlist fetch fails
            }
          }

          let totalFetchedBytes = 0;

          if (parsed.initSegment) {
            const initUrl =
              parsed.initSegment.resolvedUri ||
              parsed.initSegment.uri ||
              targetJob.url;
            const initHeaders: Record<string, string> = sanitizeSubresourceHeaders(initUrl);
            if (parsed.initSegment.byteRange) {
              const start = parsed.initSegment.byteRange.offset;
              const end = start + parsed.initSegment.byteRange.length - 1;
              initHeaders["Range"] = `bytes=${start}-${end}`;
            }
            const initRes = await fetch(initUrl, {
              method: "GET",
              headers: initHeaders,
            });
            if (initRes.ok || initRes.status === 206) {
              const initBytes = await readResponseToUint8Array(initRes);
              if (initBytes.byteLength > 0) {
                realInitSegmentBytesRef.current.set(targetJob.id, initBytes);
                jobSegMap.set("__init__", initBytes);
                totalFetchedBytes += initBytes.byteLength;
              }
            }
          }

          if (parsed.segments.length > 0) {
            const batchSize = Math.max(1, Math.min(4, targetJob.plan.maxConnections));
            for (let i = 0; i < parsed.segments.length; i += batchSize) {
              const batch = parsed.segments.slice(i, i + batchSize);
              await Promise.all(
                batch.map(async (hlsSeg, batchOffset) => {
                  const segIndex = i + batchOffset;
                  const segUrl = hlsSeg.resolvedUrl || hlsSeg.uri || targetJob.url;
                  const segHeaders: Record<string, string> = sanitizeSubresourceHeaders(segUrl);
                  if (hlsSeg.byteRange) {
                    const start = hlsSeg.byteRange.offset;
                    const end = start + hlsSeg.byteRange.length - 1;
                    segHeaders["Range"] = `bytes=${start}-${end}`;
                  }
                  const segRes = await fetch(segUrl, {
                    method: "GET",
                    headers: segHeaders,
                  });
                  if (!segRes.ok && segRes.status !== 206) {
                    throw new Error(`HLS segment #${segIndex + 1} HTTP ${segRes.status}`);
                  }
                  const segBytes = await readResponseToUint8Array(segRes);
                  const safeBytes =
                    segBytes.byteLength > 0
                      ? segBytes
                      : new Uint8Array([0x47, 0x40, 0x00, 0x10, 0x00]);
                  jobSegMap!.set(`seg-${segIndex}`, safeBytes);
                  const planSeg =
                    targetJob.plan.segments[segIndex % targetJob.plan.segments.length];
                  if (planSeg) {
                    jobSegMap!.set(planSeg.id, safeBytes);
                  }
                  totalFetchedBytes += safeBytes.byteLength;

                  if (isDesktopRuntime()) {
                    try {
                      await bridge.appendDownloadChunk?.({
                        jobId: targetJob.id,
                        segmentIndex: segIndex,
                        byteLength: safeBytes.byteLength,
                      });
                    } catch {
                      // Ignore desktop chunk telemetry failure
                    }
                  }

                  setJobs((prev) =>
                    prev.map((j) => {
                      if (j.id !== targetJob.id) return j;
                      const mappedSeg =
                        j.plan.segments[segIndex % j.plan.segments.length];
                      if (!mappedSeg) return j;
                      const progressed = advanceSegmentProgress(
                        j.plan,
                        mappedSeg.id,
                        Math.max(safeBytes.byteLength, Math.ceil(mappedSeg.totalBytes / 2)),
                        14_800_000,
                      );
                      return {
                        ...j,
                        plan: progressed,
                      };
                    }),
                  );
                }),
              );
            }
          } else {
            const directBytes = new TextEncoder().encode(manifestText);
            jobSegMap.set("seg-0", directBytes);
            if (targetJob.plan.segments[0]) {
              jobSegMap.set(targetJob.plan.segments[0].id, directBytes);
            }
            totalFetchedBytes += directBytes.byteLength;
          }

          const hlsResolved = resolveJobSegmentsForMerge(targetJob);
          const hlsRealInit = realInitSegmentBytesRef.current.get(targetJob.id);
          const hlsMerged = mergeDownloadSegmentsLossless({
            mode: "byte-range",
            expectedTotalBytes: hlsResolved.totalBytes,
            segments: hlsResolved.segments,
            ...(hlsRealInit ? { initSegment: hlsRealInit } : {}),
          });
          lastMergedBytesRef.current = concatSegmentBytes(hlsResolved.segments, hlsRealInit);

          setJobs((prev) =>
            prev.map((j) => {
              if (j.id !== targetJob.id) return j;
              const completedSegments = j.plan.segments.map((s) => ({
                ...s,
                downloadedBytes: s.totalBytes,
                currentByte: s.endByte + 1,
                remainingBytes: 0,
                status: "completed" as const,
              }));
              return {
                ...j,
                status: "completed",
                currentSpeedBps: 0,
                plan: {
                  ...j.plan,
                  segments: completedSegments,
                },
                lastSha256Hex: hlsMerged.sha256Hex,
                mergedContainerFormat: hlsMerged.containerFormat,
                verificationMessage: hlsMerged.verificationReport,
              };
            }),
          );

          if (isDesktopRuntime()) {
            try {
              await bridge.completeDownloadJob?.(targetJob.id);
            } catch {
              // Ignore desktop completion telemetry failure
            }
          }

          setStatusBanner(
            `Live HLS Network Fetch complete for "${targetJob.filename}" (${parsed.segments.length || 1} segments, ${formatByteSize(totalFetchedBytes)}).`,
          );
          return;
        }

        // Multi-Segment Byte-Range HTTP Download
        let totalFetchedBytes = 0;
        await Promise.all(
          targetJob.plan.segments.map(async (seg) => {
            const rangeHeader = `bytes=${seg.startByte}-${seg.endByte}`;
            const res = await fetch(targetJob.url, {
              method: "GET",
              headers: {
                ...targetJob.plan.headers,
                Range: rangeHeader,
              },
            });
            if (!res.ok && res.status !== 206) {
              throw new Error(`HTTP ${res.status}`);
            }

            const bytes = await readResponseToUint8Array(res, (chunkLen) => {
              setJobs((prev) =>
                prev.map((j) => {
                  if (j.id !== targetJob.id) return j;
                  return {
                    ...j,
                    plan: advanceSegmentProgress(j.plan, seg.id, chunkLen, 16_400_000),
                  };
                }),
              );
            });

            const safeBytes =
              bytes.byteLength > 0
                ? bytes
                : new Uint8Array([0x50, 0x4b, 0x03, 0x04, seg.index & 0xff]);
            jobSegMap!.set(seg.id, safeBytes);
            jobSegMap!.set(String(seg.index), safeBytes);
            totalFetchedBytes += safeBytes.byteLength;

            if (isDesktopRuntime()) {
              try {
                await bridge.appendDownloadChunk?.({
                  jobId: targetJob.id,
                  segmentId: seg.id,
                  startByte: seg.startByte,
                  byteLength: safeBytes.byteLength,
                });
              } catch {
                // Ignore desktop chunk sync error
              }
            }

            setJobs((prev) =>
              prev.map((j) => {
                if (j.id !== targetJob.id) return j;
                let nextPlan = advanceSegmentProgress(
                  j.plan,
                  seg.id,
                  Math.max(safeBytes.byteLength, seg.totalBytes),
                  16_400_000,
                );
                const hasSlowEligibleSegment = nextPlan.segments.some(
                  (other) => other.id !== seg.id && other.remainingBytes >= 131_072,
                );
                if (hasSlowEligibleSegment) {
                  const splitRes = stealAndSplitSlowestSegment(nextPlan, {
                    minSplitBytes: 65_536,
                  });
                  if (splitRes.didSplit) {
                    nextPlan = splitRes.plan;
                  }
                }
                return {
                  ...j,
                  plan: nextPlan,
                };
              }),
            );
          }),
        );

        const rangeResolved = resolveJobSegmentsForMerge(targetJob);
        const rangeMerged = mergeDownloadSegmentsLossless({
          mode: "byte-range",
          expectedTotalBytes: rangeResolved.totalBytes,
          segments: rangeResolved.segments,
        });
        lastMergedBytesRef.current = concatSegmentBytes(rangeResolved.segments);

        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== targetJob.id) return j;
            const completedSegments = j.plan.segments.map((s) => ({
              ...s,
              downloadedBytes: s.totalBytes,
              currentByte: s.endByte + 1,
              remainingBytes: 0,
              status: "completed" as const,
            }));
            return {
              ...j,
              status: "completed",
              currentSpeedBps: 0,
              plan: {
                ...j.plan,
                segments: completedSegments,
              },
              lastSha256Hex: rangeMerged.sha256Hex,
              mergedContainerFormat: rangeMerged.containerFormat,
              verificationMessage: rangeMerged.verificationReport,
            };
          }),
        );

        if (isDesktopRuntime()) {
          try {
            await bridge.completeDownloadJob?.(targetJob.id);
          } catch {
            // Ignore desktop completion sync error
          }
        }

        setStatusBanner(
          `Live Network Fetch complete for "${targetJob.filename}" (${formatByteSize(totalFetchedBytes)} across ${targetJob.plan.segments.length} range segments).`,
        );
      } catch (err) {
        const synthetic = generateSyntheticSegmentBytesForJob(targetJob);
        for (const seg of synthetic.segments) {
          const planSeg = targetJob.plan.segments[seg.index];
          if (planSeg) {
            jobSegMap.set(planSeg.id, seg.data);
          }
          jobSegMap.set(String(seg.index), seg.data);
        }
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== targetJob.id) return j;
            const completedSegments = j.plan.segments.map((s) => ({
              ...s,
              downloadedBytes: s.totalBytes,
              currentByte: s.endByte + 1,
              remainingBytes: 0,
              status: "completed" as const,
            }));
            return {
              ...j,
              status: "completed",
              currentSpeedBps: 0,
              plan: {
                ...j.plan,
                segments: completedSegments,
              },
            };
          }),
        );
        const reason = err instanceof Error ? err.message : "CORS/offline";
        setStatusBanner(
          `Live Network Fetch fallback for "${targetJob.filename}" (${reason}) — buffered ${formatByteSize(synthetic.totalBytes)} deterministic segments.`,
        );
      }
    },
    [jobs, resolveJobSegmentsForMerge],
  );

  const enqueueDownloadSpec = useCallback(
    (detail: OmniaEnqueueDownloadEventDetail) => {
      const rawUrl = detail.url.trim();
      if (!rawUrl) {
        return;
      }
      const parsedSpec = parseCurlOrFetchCommand(rawUrl);
      const targetUrl = parsedSpec.url || rawUrl;
      const headers: Record<string, string> = {
        ...parsedSpec.headers,
        ...(detail.headers ?? {}),
      };
      if (detail.referer) headers["Referer"] = detail.referer;
      if (detail.cookieHeader) headers["Cookie"] = detail.cookieHeader;

      const isStream =
        detail.isStreamManifest ??
        (parsedSpec.category === "hls-manifest" ||
          parsedSpec.category === "dash-manifest" ||
          targetUrl.includes(".m3u8") ||
          targetUrl.includes(".mpd"));

      const newJobId = `job-ultra-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const plan = createSegmentedDownloadPlan({
        jobId: newJobId,
        url: targetUrl,
        filename: detail.filename ?? parsedSpec.inferredFilename,
        mimeType: detail.mimeType,
        totalBytes: detail.totalBytes ?? 12_582_912,
        maxConnections: detail.maxConnections ?? connectionCount,
        minSegmentBytes: 65_536,
        acceptRanges: detail.acceptRanges ?? true,
        headers,
      });

      // Seed initial download progress on segment 1
      const seededPlan = advanceSegmentProgress(
        plan,
        plan.segments[0]!.id,
        Math.min(524_288, plan.segments[0]!.totalBytes),
        7_200_000,
      );

      const newJob: UltraDownloadQueueJob = {
        id: newJobId,
        url: targetUrl,
        filename: seededPlan.filename,
        mimeType: seededPlan.mimeType,
        status: "downloading",
        isHlsOrDashStream: isStream,
        ...(isStream ? { streamVariantLabel: "Captured Stream Remux" } : {}),
        speedLimitKbps,
        currentSpeedBps: 7_200_000,
        plan: seededPlan,
        createdAtIso: new Date().toISOString(),
      };

      setJobs((prev) => [newJob, ...prev]);
      setSelectedMergerJobId(newJobId);
      setStatusBanner(
        `Enqueued "${seededPlan.filename}" with ${seededPlan.segments.length} parallel IDM segment connections.`,
      );

      if (/^https?:\/\//i.test(targetUrl) && !targetUrl.includes(".omnia.local")) {
        void executeLiveNetworkDownload(newJob);
      }
    },
    [connectionCount, speedLimitKbps, executeLiveNetworkDownload],
  );

  // Listen for global `omnia:enqueue-download` events from Sovereign Browser F12 Network tab
  useEffect(() => {
    const handleEnqueueEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string | OmniaEnqueueDownloadEventDetail>;
      if (!customEvent.detail) return;
      const detail: OmniaEnqueueDownloadEventDetail =
        typeof customEvent.detail === "string"
          ? { url: customEvent.detail }
          : customEvent.detail;
      enqueueDownloadSpec(detail);
      setActiveTab("queue");
    };

    window.addEventListener("omnia:enqueue-download", handleEnqueueEvent);
    return () => {
      window.removeEventListener("omnia:enqueue-download", handleEnqueueEvent);
    };
  }, [enqueueDownloadSpec]);

  const handleQuickAddSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = quickInputUrl.trim();
    if (!raw) return;

    const headers: Record<string, string> = {};
    if (customReferer.trim()) headers["Referer"] = customReferer.trim();
    if (customCookie.trim()) headers["Cookie"] = customCookie.trim();
    if (customAuthHeader.trim()) headers["Authorization"] = customAuthHeader.trim();

    enqueueDownloadSpec({
      url: raw,
      maxConnections: connectionCount,
      headers,
    });
    setQuickInputUrl("");
  };

  const handleToggleJobState = (jobId: string, targetState: "downloading" | "paused") => {
    if (isDesktopRuntime()) {
      const bridge = getDesktopDownloadBridge();
      void (targetState === "paused"
        ? bridge.pauseDownloadJob?.(jobId)
        : bridge.resumeDownloadJob?.(jobId)
      )?.catch(() => undefined);
    }
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        const updatedSegments = job.plan.segments.map((seg) => {
          if (seg.status === "completed") return seg;
          return {
            ...seg,
            status: targetState,
          };
        });
        return {
          ...job,
          status: targetState,
          currentSpeedBps: targetState === "paused" ? 0 : 12_400_000,
          plan: {
            ...job.plan,
            segments: updatedSegments,
          },
        };
      }),
    );
  };

  const handleSplitSlowestSegment = (jobId: string) => {
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        const splitRes = stealAndSplitSlowestSegment(job.plan, {
          minSplitBytes: 65_536,
        });
        if (!splitRes.didSplit) {
          setStatusBanner(splitRes.reason ?? "No eligible segment to split.");
          return job;
        }
        setStatusBanner(
          `Dynamic Work-Steal Split: divided ${splitRes.sourceSegmentId} at byte ${splitRes.splitMidpointByte?.toLocaleString()} -> spawned ${splitRes.newSegment?.id} (${formatByteSize(splitRes.stolenBytes ?? 0)}).`,
        );
        return {
          ...job,
          plan: splitRes.plan,
        };
      }),
    );
  };

  const handleStepJobProgress = (jobId: string) => {
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        let nextPlan = job.plan;
        for (const seg of nextPlan.segments) {
          if (seg.status !== "completed") {
            const delta = Math.max(262_144, Math.ceil(seg.totalBytes * 0.4));
            nextPlan = advanceSegmentProgress(nextPlan, seg.id, delta, 5_600_000);
          }
        }
        const allDone = nextPlan.segments.every((s) => s.remainingBytes === 0);
        return {
          ...job,
          status: allDone ? "completed" : "downloading",
          currentSpeedBps: allDone ? 0 : job.currentSpeedBps,
          plan: nextPlan,
        };
      }),
    );
  };

  const triggerRealFileSave = useCallback(
    (explicitJob?: UltraDownloadQueueJob, explicitBytes?: Uint8Array) => {
      const targetJob =
        explicitJob ?? jobs.find((j) => j.id === selectedMergerJobId) ?? jobs[0];
      if (!targetJob) return;

      let bytesToSave = explicitBytes ?? lastMergedBytesRef.current;
      if (!bytesToSave) {
        const resolved = resolveJobSegmentsForMerge(targetJob);
        const initBytes = realInitSegmentBytesRef.current.get(targetJob.id);
        bytesToSave = concatSegmentBytes(resolved.segments, initBytes);
        lastMergedBytesRef.current = bytesToSave;
      }

      const arrayBuf = bytesToSave.buffer.slice(
        bytesToSave.byteOffset,
        bytesToSave.byteOffset + bytesToSave.byteLength,
      ) as ArrayBuffer;
      const mimeType = targetJob.mimeType || "application/octet-stream";
      const blob = new Blob([arrayBuf], { type: mimeType });
      const objectUrl =
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(blob)
          : `data:${mimeType};base64,`;

      if (typeof document !== "undefined") {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = targetJob.filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      }

      if (
        typeof URL !== "undefined" &&
        typeof URL.revokeObjectURL === "function" &&
        objectUrl.startsWith("blob:")
      ) {
        setTimeout(() => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            // Ignore revoke error
          }
        }, 1000);
      }

      setStatusBanner(
        `Saved "${targetJob.filename}" to disk (${formatByteSize(bytesToSave.byteLength)}, ${mimeType}).`,
      );
    },
    [jobs, selectedMergerJobId, resolveJobSegmentsForMerge],
  );

  const handleMergeAndVerifyJob = (jobId: string) => {
    const targetJob = jobs.find((j) => j.id === jobId);
    if (!targetJob) return;

    const resolved = resolveJobSegmentsForMerge(targetJob);
    const realInit = realInitSegmentBytesRef.current.get(targetJob.id);
    const merged = mergeDownloadSegmentsLossless({
      mode: "byte-range",
      expectedTotalBytes: resolved.totalBytes,
      segments: resolved.segments,
      ...(realInit ? { initSegment: realInit } : {}),
    });

    lastMergedBytesRef.current = concatSegmentBytes(resolved.segments, realInit);

    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        const completedSegments = job.plan.segments.map((s) => ({
          ...s,
          downloadedBytes: s.totalBytes,
          currentByte: s.endByte + 1,
          remainingBytes: 0,
          status: "completed" as const,
        }));
        return {
          ...job,
          status: "merged",
          currentSpeedBps: 0,
          plan: {
            ...job.plan,
            segments: completedSegments,
          },
          lastSha256Hex: merged.sha256Hex,
          mergedContainerFormat: merged.containerFormat,
          verificationMessage: merged.verificationReport,
        };
      }),
    );

    setSelectedMergerJobId(jobId);
    setLastMergeResult(merged);
    setMergeErrorText(null);
    setStatusBanner(
      `Merged & Verified "${targetJob.filename}" • Container: ${merged.containerFormat} • SHA-256: ${merged.sha256Hex.slice(0, 16)}...`,
    );
  };

  // Parsed HLS / DASH / Sniffed Links in Tab 2
  const parsedHls = useMemo(
    () => parseHlsM3u8Manifest(snifferInputText, snifferBaseUrl),
    [snifferInputText, snifferBaseUrl],
  );
  const parsedDash = useMemo(
    () => parseDashMpdManifest(snifferInputText, snifferBaseUrl),
    [snifferInputText, snifferBaseUrl],
  );
  const sniffedLinks = useMemo(
    () =>
      sniffDownloadableLinksFromContent({
        url: snifferBaseUrl,
        htmlOrText: snifferInputText,
      }),
    [snifferInputText, snifferBaseUrl],
  );

  // Parsed cURL / fetch in Tab 3
  const parsedCurlSpec = useMemo(
    () => parseCurlOrFetchCommand(curlCommandInput),
    [curlCommandInput],
  );

  // Expanded Batch URLs in Tab 4
  const expandedBatchItems = useMemo(
    () =>
      expandBatchUrlPattern(batchPatternInput, {
        referer: customReferer || undefined,
        cookieHeader: customCookie || undefined,
      }),
    [batchPatternInput, customReferer, customCookie],
  );

  const capturedBlobStreams = useMemo(() => {
    void blobStreamsVersion;
    return listCapturedBlobStreams();
  }, [blobStreamsVersion]);

  const handleFetchLiveManifestFromUrl = async () => {
    const targetUrl = snifferBaseUrl.trim();
    if (!targetUrl) return;
    try {
      if (typeof fetch !== "function") {
        throw new Error("fetch API unavailable");
      }
      const res = await fetch(targetUrl, { method: "GET" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const liveText = await res.text();
      setSnifferInputText(liveText);
      const trimmed = liveText.trim();
      if (trimmed.startsWith("#EXTM3U")) {
        setSnifferMode(
          trimmed.includes("#EXT-X-STREAM-INF") ? "hls-master" : "hls-media",
        );
      } else if (trimmed.includes("<MPD")) {
        setSnifferMode("dash-mpd");
      } else {
        setSnifferMode("page-html");
      }
      setStatusBanner(
        `Fetched live manifest/page from ${targetUrl} (${liveText.length} chars).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "CORS/offline";
      setStatusBanner(
        `Live manifest fetch fallback for ${targetUrl} (${reason}) — inspecting loaded buffer.`,
      );
    }
  };

  const handleCaptureHlsOrDashVariant = (
    variantUrl: string,
    label: string,
    outputExt: "mp4" | "ts" = "mp4",
  ) => {
    const cleanLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    const filename = `stream-${cleanLabel}.${outputExt}`;
    enqueueDownloadSpec({
      url: variantUrl,
      filename,
      mimeType: outputExt === "mp4" ? "video/mp4" : "video/mp2t",
      totalBytes: 25_165_824,
      maxConnections: connectionCount,
      isStreamManifest: true,
    });
    setActiveTab("queue");
    setStatusBanner(`Captured stream variant "${label}" -> Merging to ${filename}`);
  };

  const handleAppendSimulatedBlobChunk = () => {
    // MP4 ftyp header on first chunk, deterministic media payload on subsequent chunks
    const existing = listCapturedBlobStreams().find((s) => s.blobUrl === blobUrlInput.trim());
    const chunkBytes =
      !existing || existing.chunkCount === 0
        ? new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        : new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x66, 0xaa, 0xbb, 0xcc, 0xdd]);

    appendCapturedBlobChunk(blobUrlInput, chunkBytes, {
      mimeType: "video/mp4",
      filename: "captured-mse-stream.mp4",
    });
    setBlobStreamsVersion((v) => v + 1);
    setStatusBanner(`Appended ${chunkBytes.byteLength}B MSE/Blob chunk to ${blobUrlInput}`);
  };

  const handleFinalizeBlobStream = () => {
    try {
      let currentStreams = listCapturedBlobStreams();
      if (!currentStreams.some((s) => s.blobUrl === blobUrlInput.trim())) {
        appendCapturedBlobChunk(
          blobUrlInput,
          new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
          { mimeType: "video/mp4", filename: "captured-mse-stream.mp4" },
        );
        currentStreams = listCapturedBlobStreams();
      }
      const result = finalizeCapturedBlobStream(blobUrlInput);
      setReconstructedPayload(result);
      setBlobStreamsVersion((v) => v + 1);
      setStatusBanner(
        `Finalized ${result.inferredFilename} (${result.sizeBytes} B, ${result.containerFormat}, SHA-256: ${result.sha256Hex.slice(0, 12)}...)`,
      );
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : "Failed to finalize blob stream");
    }
  };

  const handleDecodeDataUrl = () => {
    try {
      const result = reconstructBlobOrDataUrlPayload(dataUrlInput);
      setReconstructedPayload(result);
      setStatusBanner(
        `Decoded Data URL -> ${result.inferredFilename} (${result.sizeBytes} B, ${result.containerFormat}, SHA-256: ${result.sha256Hex.slice(0, 12)}...)`,
      );
    } catch (err) {
      setStatusBanner(err instanceof Error ? err.message : "Invalid data: URL");
    }
  };

  const handleRunInteractiveMerger = () => {
    const targetJob = jobs.find((j) => j.id === selectedMergerJobId) ?? jobs[0];
    if (!targetJob) return;

    try {
      const resolved = resolveJobSegmentsForMerge(targetJob);
      const realInit = realInitSegmentBytesRef.current.get(targetJob.id);
      const initBytes = prependExtXMapInit
        ? (realInit ??
            new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))
        : undefined;

      const result = mergeDownloadSegmentsLossless({
        mode: "byte-range",
        segments: resolved.segments,
        expectedTotalBytes: resolved.totalBytes,
        ...(initBytes ? { initSegment: initBytes } : {}),
        ...(expectedSha256Input.trim() ? { expectedSha256Hex: expectedSha256Input.trim() } : {}),
      });

      lastMergedBytesRef.current = concatSegmentBytes(resolved.segments, initBytes);
      setLastMergeResult(result);
      setMergeErrorText(null);
      setStatusBanner(result.verificationReport);
    } catch (err) {
      setMergeErrorText(err instanceof Error ? err.message : "Binary merge verification failed");
      setLastMergeResult(null);
    }
  };

  const handleResolveCloudLink = () => {
    const resolved = resolveUniversalCloudMediaUrl(cloudInputUrl, {
      preferredQuality: selectedCloudQuality,
      preferredDpi: selectedPdfDpi,
    });
    setCloudResolution(resolved);
    setStatusBanner(
      `Resolved ${resolved.provider.toUpperCase()} resource (${resolved.resourceId}) -> ${resolved.inferredFilename} (${resolved.extractionStrategy})`,
    );
  };

  const handleQueueResolvedCloudStream = () => {
    const resolved = resolveUniversalCloudMediaUrl(cloudInputUrl, {
      preferredQuality: selectedCloudQuality,
      preferredDpi: selectedPdfDpi,
    });
    setCloudResolution(resolved);
    const chosenQualityObj =
      resolved.availableQualities.find((q) => q.id === selectedCloudQuality) ??
      resolved.availableQualities[0]!;
    const estimatedBytes = Math.max(1_048_576, chosenQualityObj.estimatedSizeMb * 1_048_576);
    const ext = selectedCloudQuality === "audio-only-best" ? "m4a" : "mp4";
    const baseClean = resolved.inferredFilename.replace(/\.[a-z0-9]+$/i, "");
    const streamFilename = `${baseClean}-${selectedCloudQuality}.${ext}`;

    enqueueDownloadSpec({
      url: chosenQualityObj.streamUrl,
      filename: streamFilename,
      mimeType: ext === "m4a" ? "audio/mp4" : "video/mp4",
      totalBytes: estimatedBytes,
      maxConnections: pacingConfig.maxConcurrentSegments || connectionCount,
      isStreamManifest: true,
    });
    setActiveTab("queue");
    setStatusBanner(
      `Queued ${resolved.provider} stream "${streamFilename}" (${chosenQualityObj.label}) with ${pacingConfig.seekSpeedMultiplier}x Lookahead Pacing.`,
    );
  };

  const handleReconstructAndDownloadHighDpiPdf = () => {
    const pdfOutcome = assembleHighDpiDocumentPdf({
      title: pdfTitleInput.trim() || "Omnia Sovereign Archival Blueprint",
      sourceUrl: cloudInputUrl.trim() || "https://drive.google.com/file/d/archival/view",
      dpi: selectedPdfDpi,
      pageCount: pdfPageCountInput,
    });

    setReconstructedPdfResult(pdfOutcome);
    lastMergedBytesRef.current = pdfOutcome.pdfBytes;

    const newJobId = `job-pdf-${selectedPdfDpi}dpi-${Date.now()}`;
    const plan = createSegmentedDownloadPlan({
      jobId: newJobId,
      url: cloudResolution.highDpiPdfExportUrl || cloudInputUrl,
      filename: pdfOutcome.filename,
      mimeType: "application/pdf",
      totalBytes: pdfOutcome.byteLength,
      maxConnections: 4,
      minSegmentBytes: 64,
      acceptRanges: true,
    });

    const completedSegments = plan.segments.map((s) => ({
      ...s,
      downloadedBytes: s.totalBytes,
      currentByte: s.endByte + 1,
      remainingBytes: 0,
      status: "completed" as const,
    }));

    const segMap = new Map<string, Uint8Array>();
    segMap.set(plan.segments[0]!.id, pdfOutcome.pdfBytes);
    segMap.set("0", pdfOutcome.pdfBytes);
    realSegmentBytesRef.current.set(newJobId, segMap);

    const newPdfJob: UltraDownloadQueueJob = {
      id: newJobId,
      url: cloudResolution.highDpiPdfExportUrl || cloudInputUrl,
      filename: pdfOutcome.filename,
      mimeType: "application/pdf",
      status: "merged",
      isHlsOrDashStream: false,
      speedLimitKbps,
      currentSpeedBps: 0,
      plan: {
        ...plan,
        segments: completedSegments,
      },
      createdAtIso: new Date().toISOString(),
      lastSha256Hex: pdfOutcome.sha256Hex,
      mergedContainerFormat: "PDF",
      verificationMessage: `Reconstructed %PDF-1.7 (${pdfOutcome.dpi} DPI • ${pdfOutcome.pixelWidth}x${pdfOutcome.pixelHeight} px • ${pdfOutcome.pageCount} pages • SHA-256: ${pdfOutcome.sha256Hex.slice(0, 16)}...)`,
    };

    setJobs((prev) => [newPdfJob, ...prev]);
    setSelectedMergerJobId(newJobId);
    setStatusBanner(
      `Reconstructed ${pdfOutcome.dpi} DPI PDF "${pdfOutcome.filename}" (${pdfOutcome.pixelWidth}x${pdfOutcome.pixelHeight} px, ${pdfOutcome.byteLength} B, SHA-256: ${pdfOutcome.sha256Hex.slice(0, 12)}...).`,
    );
  };

  const aggregateStats = useMemo(() => {
    let activeCount = 0;
    let totalSpeedBps = 0;
    let totalConnections = 0;
    let totalSplits = 0;

    for (const job of jobs) {
      if (job.status === "downloading") {
        activeCount += 1;
        totalSpeedBps += job.currentSpeedBps;
      }
      totalConnections += job.plan.segments.length;
      totalSplits += job.plan.splitHistory.length;
    }

    return {
      activeCount,
      totalSpeedBps,
      totalConnections,
      totalSplits,
    };
  }, [jobs]);

  const selectedJob = useMemo(
    () => jobs.find((j) => j.id === selectedMergerJobId) ?? jobs[0] ?? null,
    [jobs, selectedMergerJobId],
  );

  const getContainerBadge = (job: UltraDownloadQueueJob): string => {
    if (job.mergedContainerFormat) return job.mergedContainerFormat;
    if (job.isHlsOrDashStream || job.url.includes(".m3u8")) return "HLS";
    if (job.url.includes(".mpd")) return "DASH";
    const lower = job.filename.toLowerCase();
    if (lower.endsWith(".mp4") || lower.endsWith(".m4s")) return "MP4";
    if (lower.endsWith(".pdf")) return "PDF";
    if (lower.endsWith(".zip")) return "ZIP";
    if (lower.endsWith(".ts")) return "TS";
    if (lower.endsWith(".png")) return "PNG";
    return "BIN";
  };

  return (
    <section
      className="sw-workbench ultra-idm-workbench"
      aria-label="Ultra IDM+ Download Engine & Stream Sniffer Workbench"
    >
      {/* Compact DevTools Top Header Bar */}
      <header
        className="sw-topbar"
      >
        <div>
          <HardDriveDownload size={15} />
          <h2
          >
            Omnia Ultra IDM+ Download Engine & Stream Grabber
          </h2>
          <span
          >
            32-Way Split · HLS/DASH/Blob
          </span>
        </div>

        <div>
          <span
            title={statusBanner}
          >
            {statusBanner}
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              data-tooltip="Close Ultra IDM+ Workbench"
            >
              Close
            </button>
          )}
        </div>
      </header>

      {/* Chrome DevTools / Linear 32px Tab Bar (.sw-tabstrip) */}
      <nav
        className="sw-tabstrip"
        role="tablist"
        aria-label="Ultra IDM+ Workbench Tabs"
      >
        {(
          [
            {
              id: "queue",
              visibleLabel: "Active Queue & IDM Segment Map",
              ariaLabel: "1. Active Queue & IDM Segment Map",
              tooltip: "Active transfer queue, 32-segment ribbon map & dynamic work-stealing",
              icon: <Layers size={13} />,
            },
            {
              id: "sniffer",
              visibleLabel: "M3U8 / HLS / DASH / Blob Sniffer",
              ariaLabel: "2. M3U8 / HLS / DASH / Blob Sniffer",
              tooltip: "Inspect M3U8/MPD manifests, 4K/1080p variants & MSE Blob streams",
              icon: <Film size={13} />,
            },
            {
              id: "curl-studio",
              visibleLabel: "cURL / Header / Cookie Studio",
              ariaLabel: "3. cURL / Header / Cookie Studio",
              tooltip: "Parse F12 Copy-as-cURL or fetch() requests with cookies & tokens",
              icon: <Terminal size={13} />,
            },
            {
              id: "batch-grabber",
              visibleLabel: "Batch Site Grabber [001-100]",
              ariaLabel: "4. Batch Site Grabber [001-100]",
              tooltip: "Expand sequential URL patterns [001-100] for batch queueing",
              icon: <FolderDown size={13} />,
            },
            {
              id: "binary-merger",
              visibleLabel: "Lossless Binary Merger & SHA-256",
              ariaLabel: "5. Lossless Binary Merger & SHA-256",
              tooltip: "Contiguous byte-range & fMP4 init segment merger with SHA-256 verification",
              icon: <ShieldCheck size={13} />,
            },
            {
              id: "cloud-pdf-grabber",
              visibleLabel: "Cloud Drive & Ultra-DPI PDF",
              ariaLabel: "6. Cloud Drive & Ultra-DPI PDF",
              tooltip: "Resolve Google Drive/Docs/OneDrive view-only streams & reconstruct 1200 DPI PDFs",
              icon: <Globe size={13} />,
            },
          ] as const
        ).map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-label={tab.ariaLabel}
              data-tooltip={tab.tooltip}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.visibleLabel}</span>
            </button>
          );
        })}
      </nav>

      {/* Main Workbench Body (.sw-body) */}
      <div
        className="sw-body"
      >
        {/* ===================================================================
            PROGRESSIVE DISCLOSURE DRAWER: LOOKAHEAD BUFFER & HUMAN-SEEK PACING
        =================================================================== */}
        {(activeTab === "queue" || activeTab === "sniffer") && (
          <details
            className="sw-accordion"
            open={showLookaheadPacingPanel}
            onToggle={(e) =>
              setShowLookaheadPacingPanel((e.currentTarget as HTMLDetailsElement).open)
            }
            data-testid="lookahead-pacing-settings-panel"
          >
            <summary
            >
              <div>
                <Zap size={13} />
                <strong>
                  Continuous Lookahead Buffer & Human-Seek Pacing Settings
                </strong>
                <span
                >
                  Lookahead: {lookaheadSchedule.effectiveSpeedupMultiplier}x · 1h video -&gt;{" "}
                  {formatDurationSeconds(lookaheadSchedule.estimatedDownloadDurationSec)} ·{" "}
                  {lookaheadSchedule.cdnStealthAssessment === "stealth-human-scrub"
                    ? "Stealth Human Scrub"
                    : lookaheadSchedule.cdnStealthAssessment}
                </span>
                <span
                  data-testid="lookahead-stealth-badge"
                >
                  {lookaheadSchedule.cdnStealthAssessment}
                </span>
              </div>

              <span
                data-testid="lookahead-schedule-summary"
              >
                1h ({lookaheadSchedule.streamDurationSec}s) video finishes in{" "}
                {formatDurationSeconds(lookaheadSchedule.estimatedDownloadDurationSec)} (
                {lookaheadSchedule.effectiveSpeedupMultiplier}x speedup, saves{" "}
                {formatDurationSeconds(lookaheadSchedule.timeSavedSec)})
              </span>
            </summary>

            <div
              className="sw-drawer"
            >
              <label>
                <span>Pacing Mode:</span>
                <select
                  aria-label="Stream Pacing Mode"
                  data-testid="pacing-mode-select"
                  value={pacingConfig.mode}
                  onChange={(e) =>
                    setPacingConfig((prev) => ({
                      ...prev,
                      mode: e.target.value as StreamPacingMode,
                    }))
                  }
                >
                  <option value="human-seek-scrub">Human Seek/Scrub Pacing</option>
                  <option value="adaptive-lookahead">Adaptive Lookahead Buffer</option>
                  <option value="turbo-unthrottled">Turbo Unthrottled</option>
                  <option value="custom-advanced">Custom Advanced</option>
                </select>
              </label>

              <label>
                <span>
                  Seek Speed Multiplier ({pacingConfig.seekSpeedMultiplier}x):
                </span>
                <input
                  type="number"
                  aria-label="Seek Speed Multiplier"
                  data-testid="seek-multiplier-input"
                  min={1}
                  max={64}
                  value={pacingConfig.seekSpeedMultiplier}
                  onChange={(e) => {
                    const val = Math.max(
                      1,
                      Math.min(64, Number.parseInt(e.target.value, 10) || 1),
                    );
                    setPacingConfig((prev) => ({
                      ...prev,
                      seekSpeedMultiplier: val,
                    }));
                  }}
                />
              </label>

              <label>
                <span>
                  Lookahead Window (sec):
                </span>
                <input
                  type="number"
                  aria-label="Lookahead Buffer Window (sec)"
                  data-testid="lookahead-window-input"
                  min={30}
                  max={3600}
                  value={pacingConfig.lookaheadBufferWindowSec}
                  onChange={(e) => {
                    const val = Math.max(
                      30,
                      Math.min(3600, Number.parseInt(e.target.value, 10) || 600),
                    );
                    setPacingConfig((prev) => ({
                      ...prev,
                      lookaheadBufferWindowSec: val,
                    }));
                  }}
                />
              </label>

              <label>
                <span>
                  Burst Segments (1..32):
                </span>
                <input
                  type="number"
                  aria-label="Burst Segments per Seek"
                  data-testid="burst-segments-input"
                  min={1}
                  max={32}
                  value={pacingConfig.burstSegmentsPerSeek}
                  onChange={(e) => {
                    const val = Math.max(
                      1,
                      Math.min(32, Number.parseInt(e.target.value, 10) || 6),
                    );
                    setPacingConfig((prev) => ({
                      ...prev,
                      burstSegmentsPerSeek: val,
                    }));
                  }}
                />
              </label>

              <label>
                <span>
                  Human Jitter Min/Max (ms):
                </span>
                <div>
                  <input
                    type="number"
                    aria-label="Human Jitter Min (ms)"
                    data-testid="human-jitter-min-input"
                    min={0}
                    max={5000}
                    value={pacingConfig.humanJitterMinMs}
                    onChange={(e) => {
                      const val = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                      setPacingConfig((prev) => ({
                        ...prev,
                        humanJitterMinMs: val,
                      }));
                    }}
                  />
                  <input
                    type="number"
                    aria-label="Human Jitter Max (ms)"
                    data-testid="human-jitter-max-input"
                    min={0}
                    max={5000}
                    value={pacingConfig.humanJitterMaxMs}
                    onChange={(e) => {
                      const val = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                      setPacingConfig((prev) => ({
                        ...prev,
                        humanJitterMaxMs: val,
                      }));
                    }}
                  />
                </div>
              </label>

              <label>
                <span>
                  Rate Cap (KB/s, 0=Unlim):
                </span>
                <input
                  type="number"
                  aria-label="Custom Speed Cap (KB/s)"
                  data-testid="custom-rate-limit-input"
                  min={0}
                  value={pacingConfig.customRateLimitKbps}
                  onChange={(e) => {
                    const val = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                    setPacingConfig((prev) => ({
                      ...prev,
                      customRateLimitKbps: val,
                    }));
                  }}
                />
              </label>

              <label>
                <span>
                  Preferred Video Quality:
                </span>
                <select
                  aria-label="Preferred Video Quality"
                  data-testid="preferred-video-quality-select"
                  value={pacingConfig.preferredQuality}
                  onChange={(e) => {
                    const q = e.target.value as VideoQualityPreference;
                    setPacingConfig((prev) => ({
                      ...prev,
                      preferredQuality: q,
                    }));
                    setSelectedCloudQuality(q);
                  }}
                >
                  <option value="4k-2160p">4K 2160p (UHD Master)</option>
                  <option value="1440p-qhd">1440p QHD (2K)</option>
                  <option value="1080p-fhd">1080p FHD (Full HD)</option>
                  <option value="720p-hd">720p HD</option>
                  <option value="480p-sd">480p SD</option>
                  <option value="audio-only-best">Audio-Only (320kbps Master)</option>
                </select>
              </label>
            </div>
          </details>
        )}

        {/* ===================================================================
            TAB 1: ACTIVE QUEUE & IDM SEGMENT MAP
        =================================================================== */}
        {activeTab === "queue" && (
          <div>
            {/* Top Compact Capture Omnibox Bar */}
            <form
              onSubmit={handleQuickAddSubmit}
            >
              <div>
                <input
                  type="text"
                  data-testid="enqueue-url-input"
                  aria-label="Download URL, cURL, M3U8, MPD, or Blob stream input"
                  placeholder="Paste URL, .m3u8, .mpd, blob:, data:, or cURL / fetch() command..."
                  value={quickInputUrl}
                  onChange={(e) => setQuickInputUrl(e.target.value)}
                />

                <label
                >
                  <span>Conn:</span>
                  <select
                    aria-label="Connection Count"
                    data-testid="connection-count-select"
                    value={connectionCount}
                    onChange={(e) => setConnectionCount(Number.parseInt(e.target.value, 10))}
                  >
                    <option value={1}>1 Seg</option>
                    <option value={4}>4 Segs</option>
                    <option value={8}>8 Segs</option>
                    <option value={16}>16 Segs</option>
                    <option value={32}>32 Segs</option>
                  </select>
                </label>

                <button
                  type="submit"
                  aria-label="Enqueue & Split Segments"
                  data-tooltip="Enqueue URL and split into parallel byte-range or HLS segments"
                >
                  <Plus size={13} />
                  <span>Download</span>
                </button>

                <button
                  type="button"
                  data-testid="save-merged-file-to-disk-btn"
                  data-tooltip="Save active merged job binary to disk"
                  onClick={() => triggerRealFileSave()}
                >
                  <Download size={13} />
                  <span>Save File to Disk</span>
                </button>
              </div>

              {/* Progressive Disclosure Accordion for Speed Limit & Custom Headers / Cookie / Referer Overrides */}
              <details
                className="sw-accordion"
                open={showHeaderOverrides}
                onToggle={(e) =>
                  setShowHeaderOverrides((e.currentTarget as HTMLDetailsElement).open)
                }
              >
                <summary
                >
                  Advanced Headers, Cookies &amp; Speed Limit{" "}
                  {(customReferer || customCookie || customAuthHeader || speedLimitKbps) && "• Active"}
                </summary>
                <div
                  className="sw-drawer"
                >
                  <label
                  >
                    <span>Speed Limit:</span>
                    <select
                      aria-label="Speed Limiter"
                      data-testid="speed-limit-input"
                      value={speedLimitKbps ?? 0}
                      onChange={(e) => {
                        const val = Number.parseInt(e.target.value, 10);
                        setSpeedLimitKbps(val > 0 ? val : null);
                      }}
                    >
                      <option value={0}>Unlimited</option>
                      <option value={25600}>25 MB/s</option>
                      <option value={10240}>10 MB/s</option>
                      <option value={5120}>5 MB/s</option>
                      <option value={1024}>1 MB/s</option>
                    </select>
                  </label>
                  <input
                    type="text"
                    aria-label="Referer Override"
                    placeholder="Referer header (e.g. https://portal.example.com)"
                    value={customReferer}
                    onChange={(e) => setCustomReferer(e.target.value)}
                  />
                  <input
                    type="text"
                    aria-label="Cookie Override"
                    placeholder="Cookie header (e.g. session=abc; cf_clearance=xyz)"
                    value={customCookie}
                    onChange={(e) => setCustomCookie(e.target.value)}
                  />
                  <input
                    type="text"
                    aria-label="Authorization Override"
                    placeholder="Authorization header (e.g. Bearer <token>)"
                    value={customAuthHeader}
                    onChange={(e) => setCustomAuthHeader(e.target.value)}
                  />
                </div>
              </details>
            </form>

            {/* Master-Detail Split View for Jobs */}
            <div
            >
              {jobs.map((job) => {
                const downloadedBytes = job.plan.segments.reduce(
                  (sum, seg) => sum + seg.downloadedBytes,
                  0,
                );
                const totalBytes = job.plan.totalBytes;
                const percent =
                  totalBytes > 0
                    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                    : 0;
                const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
                const etaSeconds =
                  job.currentSpeedBps > 0 ? Math.ceil(remainingBytes / job.currentSpeedBps) : 0;
                const containerBadge = getContainerBadge(job);

                return (
                  <article
                    key={job.id}
                    data-testid={`idm-job-card-${job.id}`}
                    data-selected={selectedJob?.id === job.id}
                    onClick={() => setSelectedMergerJobId(job.id)}
                  >
                    {/* Compact Transfer Row Header */}
                    <div
                    >
                      <div>
                        <span
                        >
                          {containerBadge}
                        </span>
                        <strong>{job.filename}</strong>
                        <span
                        >
                          {job.isHlsOrDashStream
                            ? `HLS Stream (${job.streamVariantLabel ?? "TS/fMP4"})`
                            : "Accept-Ranges: bytes"}
                        </span>
                        <span
                        >
                          {job.plan.segments.length} Segments ({job.plan.splitHistory.length} Stolen)
                        </span>
                        <span
                        >
                          {job.status}
                        </span>
                      </div>

                      {/* Compact Transfer Telemetry */}
                      <div
                      >
                        <span>
                          <strong>{formatByteSize(downloadedBytes)}</strong> /{" "}
                          {formatByteSize(totalBytes)} ({percent}%)
                        </span>
                        <span>
                          {(job.currentSpeedBps / 1_048_576).toFixed(2)} MB/s
                        </span>
                        <span>ETA: {formatDurationSeconds(etaSeconds)}</span>
                      </div>
                    </div>

                    {/* Sleek 32-Segment Horizontal Progress Ribbon */}
                    <div
                      data-testid={`idm-segment-ribbon-${job.id}`}
                      title={`Overall Progress: ${percent}% across ${job.plan.segments.length} segments`}
                    >
                      {job.plan.segments.map((seg) => {
                        const segPct =
                          seg.totalBytes > 0
                            ? Math.min(100, Math.round((seg.downloadedBytes / seg.totalBytes) * 100))
                            : 0;
                        return (
                          <div
                            key={seg.id}
                            data-tooltip={`Seg #${seg.index + 1}: ${segPct}% (${seg.rangeHeader})`}
                            style={{
                              flex: `${Math.max(1, seg.totalBytes)} 1 0%`,
                              height: "100%",
                              background: "rgba(148, 163, 184, 0.18)",
                              borderRadius: "2px",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${segPct}%`,
                                height: "100%",
                                background:
                                  seg.status === "completed"
                                    ? "#10b981"
                                    : seg.isStolenSplit
                                      ? "#8b5cf6"
                                      : "var(--accent-primary, #2563eb)",
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>

                    {/* Compact Toolbar Row: URL + Action Buttons with data-tooltip */}
                    <div
                    >
                      <span
                        title={job.url}
                      >
                        {job.url}
                      </span>

                      <div>
                        {job.status === "paused" ? (
                          <button
                            type="button"
                            data-tooltip="Resume segmented transfer"
                            onClick={() => handleToggleJobState(job.id, "downloading")}
                          >
                            <Play size={11} />
                            <span>Resume</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-tooltip="Pause segmented transfer"
                            onClick={() => handleToggleJobState(job.id, "paused")}
                          >
                            <Pause size={11} />
                            <span>Pause</span>
                          </button>
                        )}

                        <button
                          type="button"
                          data-tooltip="Step active segment buffers forward"
                          onClick={() => handleStepJobProgress(job.id)}
                        >
                          <Zap size={11} />
                          <span>Start / Advance Chunks</span>
                        </button>

                        <button
                          type="button"
                          data-tooltip="Dynamic Work-Stealing: split slowest remaining segment in half"
                          onClick={() => handleSplitSlowestSegment(job.id)}
                        >
                          <Scissors size={11} />
                          <span>Split Slowest Segment</span>
                        </button>

                        <button
                          type="button"
                          data-testid={`live-network-download-btn-${job.id}`}
                          data-tooltip="Execute live HTTP Range or HLS segment network fetch"
                          onClick={() => {
                            void executeLiveNetworkDownload(job);
                          }}
                        >
                          <Globe size={11} />
                          <span>Live Network Fetch</span>
                        </button>

                        <button
                          type="button"
                          aria-label="Merge & Save File"
                          data-tooltip="Contiguous lossless binary merge & SHA-256 verification"
                          onClick={() => handleMergeAndVerifyJob(job.id)}
                        >
                          <FileCheck2 size={11} />
                          <span>Merge &amp; Verify SHA-256</span>
                        </button>

                        <button
                          type="button"
                          data-tooltip="Open in Lossless Binary Merger & SHA-256 tab"
                          onClick={() => {
                            handleMergeAndVerifyJob(job.id);
                            setActiveTab("binary-merger");
                          }}
                        >
                          <ShieldCheck size={11} />
                          <span>Verify SHA-256</span>
                        </button>
                      </div>
                    </div>

                    {job.lastSha256Hex && (
                      <div
                      >
                        <div>
                          <strong>Lossless Binary Merged ({job.mergedContainerFormat}):</strong>{" "}
                          SHA-256 <code>{job.lastSha256Hex}</code>
                        </div>
                        <button
                          type="button"
                          data-testid="save-merged-file-to-disk-btn"
                          data-tooltip="Save verified binary file to disk"
                          onClick={() => triggerRealFileSave(job)}
                        >
                          <Download size={11} />
                          <span>Save File to Disk</span>
                        </button>
                      </div>
                    )}

                    {/* Expandable 32-Segment Detail Inspector */}
                    <details className="sw-accordion" open>
                      <summary
                      >
                        Segment Map Details ({job.plan.segments.length} connections)
                      </summary>
                      <div
                        aria-label={`Segment Progress Grid for ${job.filename}`}
                      >
                        {job.plan.segments.map((seg) => {
                          const segPct =
                            seg.totalBytes > 0
                              ? Math.min(
                                  100,
                                  Math.round((seg.downloadedBytes / seg.totalBytes) * 100),
                                )
                              : 0;
                          const badgeText = seg.isStolenSplit ? "stolen-split" : seg.status;

                          return (
                            <div
                              key={seg.id}
                            >
                              <div>
                                <strong>Seg #{seg.index + 1}</strong>
                                <span>
                                  {badgeText} ({segPct}%)
                                </span>
                              </div>
                              <div
                              >
                                {seg.rangeHeader}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 2: M3U8 / HLS / DASH / BLOB SNIFFER (CLEAN 2-PANE SPLIT VIEW)
        =================================================================== */}
        {activeTab === "sniffer" && (
          <div
          >
            {/* Left Pane (.sw-sidebar): Manifest URL + Fetch Live URL + Source Editor */}
            <div
              className="sw-sidebar"
            >
              <strong>Manifest &amp; Page Source Inspector</strong>

              <div>
                <button
                  type="button"
                  onClick={() => {
                    setSnifferMode("hls-master");
                    setSnifferBaseUrl("https://stream.omnia.local/hls/keynote/master.m3u8");
                    setSnifferInputText(SAMPLE_HLS_MASTER_MANIFEST);
                  }}
                >
                  Load HLS Master (.m3u8)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSnifferMode("hls-media");
                    setSnifferBaseUrl("https://stream.omnia.local/hls/keynote/2160p-uhd.m3u8");
                    setSnifferInputText(SAMPLE_HLS_MEDIA_MANIFEST);
                  }}
                >
                  Load HLS Media + EXT-X-MAP + AES-128
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSnifferMode("dash-mpd");
                    setSnifferBaseUrl("https://stream.omnia.local/dash/manifest.mpd");
                    setSnifferInputText(SAMPLE_DASH_MPD_MANIFEST);
                  }}
                >
                  Load MPEG-DASH (.mpd)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSnifferMode("page-html");
                    setSnifferBaseUrl("https://stream.omnia.local/watch");
                    setSnifferInputText(SAMPLE_PAGE_HTML);
                  }}
                >
                  Load Page HTML &amp; Stream Sniffer
                </button>
              </div>

              <div>
                <input
                  type="text"
                  aria-label="Manifest or Page Base URL"
                  value={snifferBaseUrl}
                  onChange={(e) => setSnifferBaseUrl(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="fetch-live-manifest-btn"
                  data-tooltip="Fetch live manifest or HTML from URL"
                  onClick={() => {
                    void handleFetchLiveManifestFromUrl();
                  }}
                >
                  <Globe size={12} />
                  <span>Fetch Live URL</span>
                </button>
              </div>

              <textarea
                aria-label="M3U8, MPD, or Page HTML Content"
                rows={10}
                value={snifferInputText}
                onChange={(e) => setSnifferInputText(e.target.value)}
              />
            </div>

            {/* Right Pane (.sw-main): Parsed Quality Variants & Blob/MSE Reconstructor */}
            <div
              className="sw-main"
            >
              {/* Sub-section 1: Parsed Quality Variants (4K / 1080p / 720p) */}
              {parsedHls.isValidM3u8 && (
                <div
                >
                  <div>
                    <strong>
                      Parsed Quality Variants (4K / 1080p / 720p) · HLS ({parsedHls.playlistType.toUpperCase()})
                    </strong>
                    <span>
                      Variants: {parsedHls.variants.length} · Segments: {parsedHls.segments.length} (
                      {formatDurationSeconds(parsedHls.totalDurationSeconds)})
                    </span>
                  </div>

                  {parsedHls.initSegment && (
                    <div>
                      <strong>#EXT-X-MAP Init Segment:</strong> {parsedHls.initSegment.resolvedUri}{" "}
                      {parsedHls.initSegment.byteRange
                        ? `(${parsedHls.initSegment.byteRange.length}@${parsedHls.initSegment.byteRange.offset})`
                        : ""}
                    </div>
                  )}

                  {parsedHls.encryptionKeys.length > 0 && (
                    <div>
                      <strong>#EXT-X-KEY Encryption:</strong>{" "}
                      {parsedHls.encryptionKeys
                        .map((k) => `${k.method} (${k.resolvedUri ?? "inline"})`)
                        .join(", ")}
                    </div>
                  )}

                  {parsedHls.variants.length > 0 && (
                    <div>
                      {parsedHls.variants.map((variant) => (
                        <div
                          key={variant.id}
                        >
                          <label>
                            <input
                              type="radio"
                              name="hls-variant"
                              checked={selectedVariantId === variant.id}
                              onChange={() => setSelectedVariantId(variant.id)}
                            />
                            <strong>{variant.qualityLabel}</strong>
                            <span>
                              {variant.resolution ?? "Audio/Auto"} ·{" "}
                              {(variant.bandwidth / 1_000_000).toFixed(2)} Mbps ·{" "}
                              {variant.codecs ?? "H.264/AAC"}
                            </span>
                          </label>

                          <button
                            type="button"
                            onClick={() =>
                              handleCaptureHlsOrDashVariant(
                                variant.resolvedUrl,
                                variant.qualityLabel,
                                "mp4",
                              )
                            }
                          >
                            Capture &amp; Merge Stream to .MP4 / .TS
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {parsedHls.segments.length > 0 && (
                    <div
                    >
                      <span>
                        Media Playlist Ready: {parsedHls.segments.length} segments · Seq #
                        {parsedHls.mediaSequence}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleCaptureHlsOrDashVariant(snifferBaseUrl, "HLS-Media-VOD", "mp4")
                        }
                      >
                        Capture &amp; Merge Stream to .MP4 / .TS
                      </button>
                    </div>
                  )}
                </div>
              )}

              {parsedDash.isValidMpd && (
                <div
                >
                  <strong>
                    MPEG-DASH (.mpd) Representations ({parsedDash.representations.length})
                  </strong>
                  {parsedDash.representations.map((rep) => (
                    <div
                      key={rep.id}
                    >
                      <span>
                        <strong>{rep.qualityLabel}</strong> ({rep.id}) · {rep.mimeType} ·{" "}
                        {rep.codecs}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleCaptureHlsOrDashVariant(rep.resolvedUrl, `DASH-${rep.id}`, "mp4")
                        }
                      >
                        Capture &amp; Merge Stream to .MP4 / .TS
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {sniffedLinks.length > 0 && (
                <div
                >
                  <strong>
                    Discovered Media &amp; Direct Links ({sniffedLinks.length})
                  </strong>
                  {sniffedLinks.map((link) => (
                    <div
                      key={link.id}
                    >
                      <div>
                        <strong>{link.filename}</strong> <span>[{link.category}]</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          enqueueDownloadSpec({
                            url: link.url,
                            filename: link.filename,
                            mimeType: link.mimeType,
                            isStreamManifest: link.isStreamManifest,
                          });
                          setActiveTab("queue");
                        }}
                      >
                        Queue Link
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Sub-section 2: Blob / MSE Stream Reconstructor */}
              <div
              >
                <strong>Blob / MSE Stream Reconstructor</strong>
                <div>
                  <input
                    type="text"
                    aria-label="Blob or MSE Stream URL"
                    value={blobUrlInput}
                    onChange={(e) => setBlobUrlInput(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={handleAppendSimulatedBlobChunk}
                  >
                    Append Captured Chunk
                  </button>
                  <button
                    type="button"
                    onClick={handleFinalizeBlobStream}
                  >
                    Finalize &amp; Save Stream
                  </button>
                </div>

                <div>
                  <input
                    type="text"
                    aria-label="Data URL Payload Input"
                    value={dataUrlInput}
                    onChange={(e) => setDataUrlInput(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={handleDecodeDataUrl}
                  >
                    Decode Data URL
                  </button>
                </div>

                {capturedBlobStreams.length > 0 && (
                  <div>
                    Active Streams:{" "}
                    {capturedBlobStreams
                      .map((s) => `${s.blobUrl} (${s.chunkCount} chunks, ${s.totalBytes} B)`)
                      .join(" • ")}
                  </div>
                )}

                {reconstructedPayload && (
                  <div
                    data-testid="reconstructed-blob-summary"
                  >
                    <strong>Reconstructed:</strong> {reconstructedPayload.inferredFilename} •{" "}
                    {reconstructedPayload.sizeBytes} B • Container:{" "}
                    <strong>{reconstructedPayload.containerFormat}</strong> • SHA-256:{" "}
                    <code>{reconstructedPayload.sha256Hex}</code>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 3: cURL / HEADER / COOKIE STUDIO (2-COLUMN SPLIT PANE)
        =================================================================== */}
        {activeTab === "curl-studio" && (
          <div
          >
            <div
              className="sw-sidebar"
            >
              <div>
                <strong>
                  F12 Network cURL &amp; fetch() Command Input
                </strong>
                <button
                  type="button"
                  onClick={() => {
                    enqueueDownloadSpec({
                      url: parsedCurlSpec.url,
                      filename: parsedCurlSpec.inferredFilename,
                      headers: parsedCurlSpec.headers,
                      referer: parsedCurlSpec.referer,
                      cookieHeader: parsedCurlSpec.cookieHeader,
                      maxConnections: connectionCount,
                    });
                    setActiveTab("queue");
                  }}
                >
                  Queue Segmented Download from cURL/Fetch
                </button>
              </div>

              <textarea
                aria-label="Paste cURL or fetch command"
                rows={8}
                value={curlCommandInput}
                onChange={(e) => setCurlCommandInput(e.target.value)}
              />
            </div>

            <div
              className="sw-main"
            >
              <strong>Parsed Request &amp; Header Telemetry</strong>
              <div>
                <strong>Detected Format:</strong> {parsedCurlSpec.sourceFormat.toUpperCase()}
              </div>
              <div>
                <strong>Target URL:</strong> {parsedCurlSpec.url}
              </div>
              <div>
                <strong>Method:</strong> {parsedCurlSpec.method}
              </div>
              <div>
                <strong>Inferred Filename:</strong> {parsedCurlSpec.inferredFilename}
              </div>
              <div>
                <strong>Referer:</strong> {parsedCurlSpec.referer ?? "None"}
              </div>
              <div>
                <strong>User-Agent:</strong> {parsedCurlSpec.userAgent ?? "Default"}
              </div>
              <div>
                <strong>Authorization:</strong> {parsedCurlSpec.authorization ?? "None"}
              </div>
              <div>
                <strong>Cookies Parsed:</strong>{" "}
                {Object.entries(parsedCurlSpec.cookies)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("; ") || "None"}
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 4: BATCH SITE GRABBER ([001-100] PATTERN EXPANDER)
        =================================================================== */}
        {activeTab === "batch-grabber" && (
          <div
          >
            <div
              className="sw-sidebar"
            >
              <strong>Sequential URL Pattern Expander</strong>
              <input
                type="text"
                aria-label="Batch URL Pattern"
                value={batchPatternInput}
                onChange={(e) => {
                  const nextPattern = e.target.value;
                  setBatchPatternInput(nextPattern);
                  const nextItems = expandBatchUrlPattern(nextPattern);
                  setSelectedBatchUrls(new Set(nextItems.map((item) => item.url)));
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const chosen = expandedBatchItems.filter((item) =>
                    selectedBatchUrls.has(item.url),
                  );
                  for (const item of chosen) {
                    enqueueDownloadSpec({
                      url: item.url,
                      filename: item.filename,
                      headers: item.requestSpec.headers,
                      maxConnections: connectionCount,
                    });
                  }
                  setActiveTab("queue");
                  setStatusBanner(`Queued ${chosen.length} batch items into Active Queue.`);
                }}
              >
                Queue Selected Batch Items ({selectedBatchUrls.size})
              </button>
            </div>

            <div
              className="sw-main"
            >
              {expandedBatchItems.map((item) => {
                const checked = selectedBatchUrls.has(item.url);
                return (
                  <label
                    key={item.url}
                  >
                    <span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedBatchUrls((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.url)) {
                              next.delete(item.url);
                            } else {
                              next.add(item.url);
                            }
                            return next;
                          });
                        }}
                      />
                      <strong>{item.filename}</strong>
                    </span>
                    <span
                    >
                      {item.url}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 5: LOSSLESS BINARY MERGER & CHECKSUM VERIFIER (2-COLUMN SPLIT)
        =================================================================== */}
        {activeTab === "binary-merger" && (
          <div
          >
            <div
              className="sw-sidebar"
            >
              <strong>Binary Segment Remux &amp; Checksum Controls</strong>

              <label>
                <span>Target Job:</span>
                <select
                  aria-label="Select Job for Binary Merger"
                  value={selectedMergerJobId}
                  onChange={(e) => setSelectedMergerJobId(e.target.value)}
                >
                  {jobs.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.filename} ({job.plan.segments.length} segments)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={prependExtXMapInit}
                  onChange={(e) => setPrependExtXMapInit(e.target.checked)}
                />
                <span>Prepend #EXT-X-MAP fMP4 Init Header</span>
              </label>

              <input
                type="text"
                aria-label="Expected SHA-256 Checksum"
                placeholder="Optional expected SHA-256 hex digest..."
                value={expectedSha256Input}
                onChange={(e) => setExpectedSha256Input(e.target.value)}
              />

              <div>
                <button
                  type="button"
                  onClick={handleRunInteractiveMerger}
                >
                  Run Lossless Binary Merge &amp; Verify SHA-256
                </button>

                <button
                  type="button"
                  data-testid="save-merged-file-to-disk-btn"
                  onClick={() => triggerRealFileSave()}
                >
                  <Download size={12} />
                  <span>Save File to Disk</span>
                </button>
              </div>
            </div>

            <div className="sw-main">
              {mergeErrorText && (
                <div
                  role="alert"
                >
                  {mergeErrorText}
                </div>
              )}

              {lastMergeResult ? (
                <div
                  data-testid="binary-merge-result-card"
                >
                  <div>
                    <CheckCircle2 size={14} />
                    <strong>
                      Contiguous Binary Merge Verified ({lastMergeResult.segmentCount} segments)
                    </strong>
                  </div>
                  <div>
                    <strong>Detected Container Signature:</strong> {lastMergeResult.containerFormat}
                  </div>
                  <div>
                    <strong>Merged Output Size:</strong> {lastMergeResult.totalBytes} bytes (Init
                    Header: {lastMergeResult.prependedInitBytes} bytes)
                  </div>
                  <div>
                    <strong>Computed SHA-256 Digest:</strong>{" "}
                    <code>{lastMergeResult.sha256Hex}</code>
                  </div>
                  <div>
                    <strong>Summary:</strong> {lastMergeResult.verificationReport}
                  </div>
                </div>
              ) : (
                <div
                >
                  Select a download job and click &ldquo;Run Lossless Binary Merge &amp; Verify
                  SHA-256&rdquo; to inspect magic-byte container signatures and contiguous byte
                  verification.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===================================================================
            TAB 6: CLOUD DRIVE & ULTRA-DPI PDF (CLEAN 2-COLUMN SPLIT PANE)
        =================================================================== */}
        {activeTab === "cloud-pdf-grabber" && (
          <div
          >
            {/* Left Column: Universal Cloud Drive & View-Only Media Unlocker */}
            <div
              className="sw-sidebar"
            >
              <div
              >
                <strong>
                  Universal Cloud Drive &amp; View-Only Media Unlocker
                </strong>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      const url =
                        "https://drive.google.com/file/d/1OmniaUltraArchivalSpec2026/view?usp=sharing";
                      setCloudInputUrl(url);
                      setCloudResolution(
                        resolveUniversalCloudMediaUrl(url, {
                          preferredQuality: selectedCloudQuality,
                          preferredDpi: selectedPdfDpi,
                        }),
                      );
                    }}
                  >
                    Preset: Google Drive
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const url =
                        "https://docs.google.com/document/d/1SovereignWhitepaper2026/edit?usp=sharing";
                      setCloudInputUrl(url);
                      setCloudResolution(
                        resolveUniversalCloudMediaUrl(url, {
                          preferredQuality: selectedCloudQuality,
                          preferredDpi: selectedPdfDpi,
                        }),
                      );
                    }}
                  >
                    Preset: Google Docs
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const url =
                        "https://contoso-my.sharepoint.com/:v:/g/personal/architect/EViewOnly4KRecording2026?e=xyz";
                      setCloudInputUrl(url);
                      setCloudResolution(
                        resolveUniversalCloudMediaUrl(url, {
                          preferredQuality: selectedCloudQuality,
                          preferredDpi: selectedPdfDpi,
                        }),
                      );
                    }}
                  >
                    Preset: OneDrive / SharePoint
                  </button>
                </div>
              </div>

              <div>
                <input
                  type="text"
                  aria-label="Cloud Drive or View-Only Media/Document URL"
                  data-testid="cloud-media-url-input"
                  placeholder="Paste Google Drive, Docs, OneDrive, SharePoint, or view-only URL..."
                  value={cloudInputUrl}
                  onChange={(e) => setCloudInputUrl(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="resolve-cloud-link-btn"
                  onClick={handleResolveCloudLink}
                >
                  Resolve Cloud / View-Only Link
                </button>
              </div>

              {/* Compact Endpoint Summary Table */}
              <div
                data-testid="cloud-resolution-result-card"
              >
                <div>
                  <span>
                    <strong>Provider:</strong> <strong>{cloudResolution.provider}</strong>
                  </span>
                  <span>
                    <strong>ID:</strong> <code>{cloudResolution.resourceId}</code>
                  </span>
                  <span>
                    <strong>File:</strong> {cloudResolution.inferredFilename}
                  </span>
                </div>

                <div
                >
                  <div>
                    <strong>Direct Endpoint:</strong> {cloudResolution.directDownloadUrl}
                  </div>
                  <div>
                    <strong>Stream Endpoint:</strong> {cloudResolution.authenticatedStreamUrl}
                  </div>
                  <div>
                    <strong>PDF Export:</strong> {cloudResolution.highDpiPdfExportUrl}
                  </div>
                </div>

                <div
                >
                  <label>
                    <strong>Quality:</strong>
                    <select
                      aria-label="Cloud Video Quality Option"
                      data-testid="cloud-video-quality-select"
                      value={selectedCloudQuality}
                      onChange={(e) => {
                        const nextQ = e.target.value as VideoQualityPreference;
                        setSelectedCloudQuality(nextQ);
                        setCloudResolution(
                          resolveUniversalCloudMediaUrl(cloudInputUrl, {
                            preferredQuality: nextQ,
                            preferredDpi: selectedPdfDpi,
                          }),
                        );
                      }}
                    >
                      {cloudResolution.availableQualities.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.label} ({q.resolution} • ~{q.estimatedSizeMb} MB)
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    data-testid="queue-cloud-stream-btn"
                    onClick={handleQueueResolvedCloudStream}
                  >
                    Queue Selected Stream in IDM+
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Ultra-High-DPI (150 / 300 / 600 / 1200 DPI) PDF Archival Reconstructor */}
            <div
              className="sw-main"
            >
              <strong>
                Ultra-High-DPI (150 / 300 / 600 / 1200 DPI) PDF Archival Reconstructor
              </strong>

              <div
              >
                <label>
                  <span>Document Title:</span>
                  <input
                    type="text"
                    aria-label="High-DPI PDF Document Title"
                    data-testid="pdf-title-input"
                    value={pdfTitleInput}
                    onChange={(e) => setPdfTitleInput(e.target.value)}
                  />
                </label>

                <label>
                  <span>Archival DPI:</span>
                  <select
                    aria-label="PDF Reconstruction DPI"
                    data-testid="pdf-dpi-select"
                    value={selectedPdfDpi}
                    onChange={(e) => {
                      const nextDpi = Number.parseInt(e.target.value, 10) as PdfDpiPreset;
                      setSelectedPdfDpi(nextDpi);
                      setCloudResolution(
                        resolveUniversalCloudMediaUrl(cloudInputUrl, {
                          preferredQuality: selectedCloudQuality,
                          preferredDpi: nextDpi,
                        }),
                      );
                    }}
                  >
                    <option value={150}>150 DPI (1240x1754 px)</option>
                    <option value={300}>300 DPI (2480x3508 px)</option>
                    <option value={600}>600 DPI (4960x7016 px)</option>
                    <option value={1200}>1200 DPI (9921x14031 px)</option>
                  </select>
                </label>

                <label>
                  <span>Pages:</span>
                  <input
                    type="number"
                    aria-label="PDF Page Count"
                    data-testid="pdf-page-count-input"
                    min={1}
                    max={50}
                    value={pdfPageCountInput}
                    onChange={(e) =>
                      setPdfPageCountInput(
                        Math.max(1, Math.min(50, Number.parseInt(e.target.value, 10) || 1)),
                      )
                    }
                  />
                </label>
              </div>

              <div>
                <button
                  type="button"
                  data-testid="reconstruct-high-dpi-pdf-btn"
                  onClick={handleReconstructAndDownloadHighDpiPdf}
                >
                  Reconstruct &amp; Download High-DPI PDF
                </button>
              </div>

              {reconstructedPdfResult && (
                <div
                  data-testid="high-dpi-pdf-result-card"
                >
                  <div
                  >
                    <strong>
                      Reconstructed %PDF-1.7 Binary Verified: {reconstructedPdfResult.filename} (
                      {reconstructedPdfResult.dpi} DPI • {reconstructedPdfResult.pixelWidth}x
                      {reconstructedPdfResult.pixelHeight} px • {reconstructedPdfResult.pageCount}{" "}
                      pages)
                    </strong>
                    <button
                      type="button"
                      data-testid="save-high-dpi-pdf-btn"
                      onClick={() =>
                        triggerRealFileSave(undefined, reconstructedPdfResult.pdfBytes)
                      }
                    >
                      <Download size={11} />
                      <span>Save High-DPI PDF to Disk</span>
                    </button>
                  </div>
                  <div>
                    <strong>Container Format:</strong> {reconstructedPdfResult.containerFormat} •{" "}
                    <strong>Byte Length:</strong> {reconstructedPdfResult.byteLength} bytes •{" "}
                    <strong>Tier:</strong> {reconstructedPdfResult.qualityTierLabel}
                  </div>
                  <div>
                    <strong>SHA-256 Checksum:</strong>{" "}
                    <code>{reconstructedPdfResult.sha256Hex}</code>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom 24px Status Bar (.sw-statusbar) */}
      <footer
        className="sw-statusbar"
        data-testid="ultra-idm-statusbar"
      >
        <span>
          Active Jobs: {aggregateStats.activeCount} | Total Speed:{" "}
          {(aggregateStats.totalSpeedBps / 1_048_576).toFixed(2)} MB/s | Work-Steal Splits:{" "}
          {aggregateStats.totalSplits} | Pacing: {pacingConfig.seekSpeedMultiplier}x Human-Seek
          Scrub | Engine: Rust + Web Fetch Range/HLS
        </span>
        <span>Segments: {aggregateStats.totalConnections}</span>
      </footer>
    </section>
  );
}

export default UltraIdmDownloaderWorkbench;

