import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceSegmentProgress,
  appendCapturedBlobChunk,
  assembleHighDpiDocumentPdf,
  clearCapturedBlobStreams,
  computeBytesSha256Hex,
  computeLookaheadBufferSchedule,
  createSegmentedDownloadPlan,
  DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
  detectContainerFormatFromBytes,
  expandBatchUrlPattern,
  finalizeCapturedBlobStream,
  listCapturedBlobStreams,
  mergeDownloadSegmentsLossless,
  parseCurlOrFetchCommand,
  parseDashMpdManifest,
  parseHlsM3u8Manifest,
  reconstructBlobOrDataUrlPayload,
  resolveUniversalCloudMediaUrl,
  sniffDownloadableLinksFromContent,
  stealAndSplitSlowestSegment,
} from "@/domain/omnia-ultra-downloader";

describe("omnia-ultra-downloader domain engine", () => {
  beforeEach(() => {
    clearCapturedBlobStreams();
  });

  describe("1. Universal Link, Media & Stream Sniffer (sniffDownloadableLinksFromContent)", () => {
    it("extracts direct links, .m3u8 HLS, .mpd DASH, blob:, data:, <source>, MSE streams, and JSON embedded URLs", () => {
      const htmlOrText = `
        <html>
          <body>
            <a href="/releases/omnia-installer-x64.exe" download>Download Installer</a>
            <a href="https://cdn.example.com/archive/dataset-2026.zip">Dataset ZIP</a>
            <video controls poster="/thumb.jpg">
              <source src="/streams/master.m3u8" type="application/vnd.apple.mpegurl" label="Auto HLS" />
              <source src="https://media.example.com/video/1080p.mp4" type="video/mp4" data-quality="1080p" />
            </video>
            <div data-mse-stream="mse://media-source-buffer/video-track-1"></div>
            <script>
              const playerConfig = {
                "hlsUrl": "https:\\/\\/edge.example.com\\/live\\/index.m3u8?token=abc",
                "dashUrl": "https:\\/\\/edge.example.com\\/vod\\/manifest.mpd",
                "downloadUrl": "https:\\/\\/edge.example.com\\/files\\/whitepaper.pdf"
              };
              const activeBlob = "blob:https://player.example.com/9f8e7d6c-1122-3344-5566-778899aabbcc";
              const inlineData = "data:application/pdf;base64,JVBERi0xLjcK";
            </script>
          </body>
        </html>
      `;

      const sniffed = sniffDownloadableLinksFromContent({
        url: "https://player.example.com/watch/42",
        htmlOrText,
        networkLog: [
          {
            url: "https://cdn.example.com/InitSegment.m4s",
            mimeType: "video/iso.segment",
            sizeBytes: 1_048_576,
            initiator: "MSE SourceBuffer",
            responseHeaders: {
              "Accept-Ranges": "bytes",
              "Content-Length": "1048576",
            },
          },
          {
            url: "https://cdn.example.com/download?id=99",
            responseHeaders: {
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment; filename="bundle-v2.zip"',
              "Accept-Ranges": "bytes",
              "Content-Length": "52428800",
            },
          },
        ],
      });

      const urls = sniffed.map((item) => item.url);
      expect(urls).toContain("https://player.example.com/releases/omnia-installer-x64.exe");
      expect(urls).toContain("https://cdn.example.com/archive/dataset-2026.zip");
      expect(urls).toContain("https://player.example.com/streams/master.m3u8");
      expect(urls).toContain("https://media.example.com/video/1080p.mp4");
      expect(urls).toContain("mse://media-source-buffer/video-track-1");
      expect(urls).toContain("https://edge.example.com/live/index.m3u8?token=abc");
      expect(urls).toContain("https://edge.example.com/vod/manifest.mpd");
      expect(urls).toContain("https://edge.example.com/files/whitepaper.pdf");
      expect(urls).toContain(
        "blob:https://player.example.com/9f8e7d6c-1122-3344-5566-778899aabbcc",
      );
      expect(urls).toContain("data:application/pdf;base64,JVBERi0xLjcK");
      expect(urls).toContain("https://cdn.example.com/InitSegment.m4s");

      const hlsItem = sniffed.find(
        (item) => item.url === "https://player.example.com/streams/master.m3u8",
      );
      expect(hlsItem?.category).toBe("hls-manifest");
      expect(hlsItem?.isStreamManifest).toBe(true);

      const dashItem = sniffed.find(
        (item) => item.url === "https://edge.example.com/vod/manifest.mpd",
      );
      expect(dashItem?.category).toBe("dash-manifest");
      expect(dashItem?.isStreamManifest).toBe(true);

      const dispositionItem = sniffed.find(
        (item) => item.url === "https://cdn.example.com/download?id=99",
      );
      expect(dispositionItem?.filename).toBe("bundle-v2.zip");
      expect(dispositionItem?.supportsByteRange).toBe(true);
      expect(dispositionItem?.estimatedBytes).toBe(52_428_800);
    });
  });

  describe("2. Full HLS (.m3u8) Master & Media Playlist Parser (parseHlsM3u8Manifest)", () => {
    it("parses a Master playlist, sorts variants from highest quality (4K -> 1080p -> 720p) to lowest, and parses #EXT-X-MEDIA renditions", () => {
      const masterM3u8 = `
        #EXTM3U
        #EXT-X-VERSION:6
        #EXT-X-INDEPENDENT-SEGMENTS
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English Stereo",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/prog.m3u8"
        #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs/en.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=2800000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio-aac",SUBTITLES="subs"
        720p/prog_index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=18500000,AVERAGE-BANDWIDTH=15200000,RESOLUTION=3840x2160,FRAME-RATE=60.000,CODECS="hev1.1.6.L153.B0,mp4a.40.2",AUDIO="audio-aac",SUBTITLES="subs"
        2160p/prog_index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=6200000,AVERAGE-BANDWIDTH=5500000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2",AUDIO="audio-aac",SUBTITLES="subs"
        1080p/prog_index.m3u8
      `;

      const parsed = parseHlsM3u8Manifest(
        masterM3u8,
        "https://stream.example.com/hls/movie/master.m3u8",
      );

      expect(parsed.isValidM3u8).toBe(true);
      expect(parsed.playlistType).toBe("master");
      expect(parsed.version).toBe(6);
      expect(parsed.independentSegments).toBe(true);
      expect(parsed.variants).toHaveLength(3);

      // Highest quality (4K -> 1080p -> 720p)
      expect(parsed.variants[0]?.height).toBe(2160);
      expect(parsed.variants[0]?.qualityLabel).toContain("4K");
      expect(parsed.variants[0]?.resolvedUrl).toBe(
        "https://stream.example.com/hls/movie/2160p/prog_index.m3u8",
      );

      expect(parsed.variants[1]?.height).toBe(1080);
      expect(parsed.variants[1]?.resolvedUrl).toBe(
        "https://stream.example.com/hls/movie/1080p/prog_index.m3u8",
      );

      expect(parsed.variants[2]?.height).toBe(720);
      expect(parsed.variants[2]?.resolvedUrl).toBe(
        "https://stream.example.com/hls/movie/720p/prog_index.m3u8",
      );

      expect(parsed.renditions).toHaveLength(2);
      expect(parsed.renditions[0]?.type).toBe("AUDIO");
      expect(parsed.renditions[0]?.resolvedUrl).toBe(
        "https://stream.example.com/hls/movie/audio/en/prog.m3u8",
      );
      expect(parsed.renditions[1]?.type).toBe("SUBTITLES");
    });

    it("parses a Media playlist with #EXT-X-MAP, #EXT-X-KEY, #EXTINF, #EXT-X-BYTERANGE, #EXT-X-DISCONTINUITY, and #EXT-X-ENDLIST", () => {
      const mediaM3u8 = `
        #EXTM3U
        #EXT-X-VERSION:7
        #EXT-X-TARGETDURATION:6
        #EXT-X-MEDIA-SEQUENCE:100
        #EXT-X-PLAYLIST-TYPE:VOD
        #EXT-X-MAP:URI="init-header.mp4",BYTERANGE="812@0"
        #EXT-X-KEY:METHOD=AES-128,URI="../keys/key1.bin",IV=0x00000000000000000000000000000064
        #EXTINF:5.500,Intro Part 1
        #EXT-X-BYTERANGE:120000@812
        seg-100.m4s
        #EXTINF:6.000,Intro Part 2
        #EXT-X-BYTERANGE:135000
        seg-101.m4s
        #EXT-X-DISCONTINUITY
        #EXTINF:4.250,Main Feature
        seg-102.m4s
        #EXT-X-ENDLIST
      `;

      const parsed = parseHlsM3u8Manifest(
        mediaM3u8,
        "https://stream.example.com/hls/movie/1080p/prog_index.m3u8",
      );

      expect(parsed.isValidM3u8).toBe(true);
      expect(parsed.playlistType).toBe("media");
      expect(parsed.mediaPlaylistType).toBe("VOD");
      expect(parsed.targetDuration).toBe(6);
      expect(parsed.mediaSequence).toBe(100);
      expect(parsed.hasEndList).toBe(true);
      expect(parsed.isLive).toBe(false);
      expect(parsed.hasEncryption).toBe(true);
      expect(parsed.totalDurationSeconds).toBeCloseTo(15.75, 2);

      expect(parsed.initSegment?.resolvedUri).toBe(
        "https://stream.example.com/hls/movie/1080p/init-header.mp4",
      );
      expect(parsed.initSegment?.byteRange).toEqual({ length: 812, offset: 0 });

      expect(parsed.encryptionKeys[0]?.method).toBe("AES-128");
      expect(parsed.encryptionKeys[0]?.resolvedUri).toBe(
        "https://stream.example.com/hls/movie/keys/key1.bin",
      );
      expect(parsed.encryptionKeys[0]?.iv).toBe("0x00000000000000000000000000000064");

      expect(parsed.segments).toHaveLength(3);
      expect(parsed.segments[0]?.sequenceNumber).toBe(100);
      expect(parsed.segments[0]?.byteRange).toEqual({ length: 120000, offset: 812 });
      expect(parsed.segments[0]?.resolvedUrl).toBe(
        "https://stream.example.com/hls/movie/1080p/seg-100.m4s",
      );

      // Implicit byte-range offset continuation: 812 + 120000 = 120812
      expect(parsed.segments[1]?.sequenceNumber).toBe(101);
      expect(parsed.segments[1]?.byteRange).toEqual({ length: 135000, offset: 120812 });

      expect(parsed.segments[2]?.sequenceNumber).toBe(102);
      expect(parsed.segments[2]?.discontinuity).toBe(true);
    });
  });

  describe("3. Full MPEG-DASH (.mpd) Manifest Parser (parseDashMpdManifest)", () => {
    it("parses AdaptationSets, Representations, SegmentTemplates, and sorts video representations by quality", () => {
      const mpdXml = `<?xml version="1.0" encoding="UTF-8"?>
        <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S">
          <Period id="p0">
            <AdaptationSet id="video-set" mimeType="video/mp4" contentType="video" segmentAlignment="true">
              <SegmentTemplate timescale="1000" duration="4000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%04d$.m4s" startNumber="1" />
              <Representation id="v720" codecs="avc1.64001f" width="1280" height="720" frameRate="30" bandwidth="2500000" />
              <Representation id="v1080" codecs="avc1.640028" width="1920" height="1080" frameRate="60" bandwidth="6800000" />
            </AdaptationSet>
            <AdaptationSet id="audio-set" mimeType="audio/mp4" contentType="audio" lang="en" segmentAlignment="true">
              <Representation id="a128" codecs="mp4a.40.2" audioSamplingRate="48000" bandwidth="128000">
                <BaseURL>audio-en-128k.m4a</BaseURL>
              </Representation>
            </AdaptationSet>
          </Period>
        </MPD>
      `;

      const parsed = parseDashMpdManifest(
        mpdXml,
        "https://dash.example.com/streams/feature.mpd",
      );

      expect(parsed.isValidMpd).toBe(true);
      expect(parsed.type).toBe("static");
      expect(parsed.mediaPresentationDurationSeconds).toBe(12);
      expect(parsed.adaptationSets).toHaveLength(2);
      expect(parsed.videoRepresentations).toHaveLength(2);
      expect(parsed.audioRepresentations).toHaveLength(1);

      // Sorted 1080p before 720p
      const topVideo = parsed.videoRepresentations[0];
      expect(topVideo?.id).toBe("v1080");
      expect(topVideo?.width).toBe(1920);
      expect(topVideo?.height).toBe(1080);
      expect(topVideo?.initializationUrl).toBe(
        "https://dash.example.com/streams/init-v1080.m4s",
      );
      expect(topVideo?.segmentUrls).toEqual([
        "https://dash.example.com/streams/chunk-v1080-0001.m4s",
        "https://dash.example.com/streams/chunk-v1080-0002.m4s",
        "https://dash.example.com/streams/chunk-v1080-0003.m4s",
      ]);

      const audioRep = parsed.audioRepresentations[0];
      expect(audioRep?.id).toBe("a128");
      expect(audioRep?.resolvedUrl).toBe(
        "https://dash.example.com/streams/audio-en-128k.m4a",
      );
    });
  });

  describe("4. Blob / Data URL & MSE Stream Reconstructor", () => {
    it("decodes data: base64 URLs into Uint8Array, computes SHA-256, and detects PDF/MP4 container format", () => {
      // "%PDF-1.7\n" in base64 is "JVBERi0xLjcK"
      const reconstructed = reconstructBlobOrDataUrlPayload(
        "data:application/pdf;base64,JVBERi0xLjcK",
      );

      expect(reconstructed.sourceKind).toBe("data-url");
      expect(reconstructed.mimeType).toBe("application/pdf");
      expect(reconstructed.isBase64).toBe(true);
      expect(reconstructed.sizeBytes).toBe(9);
      expect(reconstructed.containerFormat).toBe("PDF");
      expect(reconstructed.extension).toBe("pdf");
      expect(reconstructed.sha256Hex).toHaveLength(64);
    });

    it("captures multi-chunk blob: streams and finalizes them into a verified MP4/fMP4 payload", () => {
      const blobUrl = "blob:https://video.example.com/stream-uuid-101";
      // Construct an fMP4 header with 'ftyp' at bytes 4..8
      const chunk1 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const chunk2 = new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);

      const snap1 = appendCapturedBlobChunk(blobUrl, chunk1, {
        mimeType: "video/mp4",
        filename: "captured-4k.mp4",
      });
      expect(snap1.chunkCount).toBe(1);
      expect(snap1.totalBytes).toBe(8);

      const snap2 = appendCapturedBlobChunk(blobUrl, chunk2);
      expect(snap2.chunkCount).toBe(2);
      expect(snap2.totalBytes).toBe(16);
      expect(listCapturedBlobStreams()).toHaveLength(1);

      const finalized = finalizeCapturedBlobStream(blobUrl);
      expect(finalized.sizeBytes).toBe(16);
      expect(finalized.chunkCount).toBe(2);
      expect(finalized.containerFormat).toBe("MP4/fMP4");
      expect(finalized.inferredFilename).toBe("captured-4k.mp4");
      expect(finalized.sha256Hex).toBe(
        computeBytesSha256Hex(new Uint8Array([...chunk1, ...chunk2])),
      );
    });
  });

  describe("5. cURL & Fetch Command Parser (parseCurlOrFetchCommand)", () => {
    it("parses browser F12 curl commands with cookies, referer, user-agent, and authorization headers", () => {
      const curlCmd = `curl 'https://cdn.example.com/private/movie-4k.mkv?sig=9988' \\
        -H 'Cookie: session_id=xyz987; cf_clearance=pass123' \\
        -H 'Referer: https://portal.example.com/player' \\
        -H 'User-Agent: Mozilla/5.0 OmniaUltra/2.0' \\
        -H 'Authorization: Bearer secret-jwt-token'`;

      const spec = parseCurlOrFetchCommand(curlCmd);
      expect(spec.sourceFormat).toBe("curl");
      expect(spec.url).toBe("https://cdn.example.com/private/movie-4k.mkv?sig=9988");
      expect(spec.method).toBe("GET");
      expect(spec.inferredFilename).toBe("movie-4k.mkv");
      expect(spec.extension).toBe("mkv");
      expect(spec.category).toBe("video");
      expect(spec.referer).toBe("https://portal.example.com/player");
      expect(spec.userAgent).toBe("Mozilla/5.0 OmniaUltra/2.0");
      expect(spec.authorization).toBe("Bearer secret-jwt-token");
      expect(spec.cookies).toEqual({
        session_id: "xyz987",
        cf_clearance: "pass123",
      });
    });

    it("parses DevTools fetch() snippets with headers and referrer", () => {
      const fetchCmd = `fetch("https://edge.example.com/hls/live-master.m3u8", {
        "headers": {
          "accept": "*/*",
          "authorization": "Bearer fetch-token-42",
          "cookie": "auth=ok"
        },
        "referrer": "https://edge.example.com/embed",
        "method": "GET"
      });`;

      const spec = parseCurlOrFetchCommand(fetchCmd);
      expect(spec.sourceFormat).toBe("fetch");
      expect(spec.url).toBe("https://edge.example.com/hls/live-master.m3u8");
      expect(spec.category).toBe("hls-manifest");
      expect(spec.authorization).toBe("Bearer fetch-token-42");
      expect(spec.referer).toBe("https://edge.example.com/embed");
      expect(spec.cookies["auth"]).toBe("ok");
    });
  });

  describe("6. Batch Pattern URL Expander (expandBatchUrlPattern)", () => {
    it("expands zero-padded numeric ranges [001-020] and alphabetic ranges [a-f]", () => {
      const numericBatch = expandBatchUrlPattern(
        "https://cdn.example.com/part-[001-020].zip",
      );
      expect(numericBatch).toHaveLength(20);
      expect(numericBatch[0]?.url).toBe("https://cdn.example.com/part-001.zip");
      expect(numericBatch[0]?.filename).toBe("part-001.zip");
      expect(numericBatch[19]?.url).toBe("https://cdn.example.com/part-020.zip");
      expect(numericBatch[19]?.filename).toBe("part-020.zip");

      const alphaBatch = expandBatchUrlPattern(
        "https://cdn.example.com/mirror-[a-f]/archive.7z",
      );
      expect(alphaBatch).toHaveLength(6);
      expect(alphaBatch[0]?.url).toBe("https://cdn.example.com/mirror-a/archive.7z");
      expect(alphaBatch[5]?.url).toBe("https://cdn.example.com/mirror-f/archive.7z");
    });
  });

  describe("7. True IDM Dynamic Segment Splitting, Work-Stealing & Lossless Binary Merger", () => {
    it("creates an initial N-segment plan and dynamically work-steals/splits the slowest segment at midpoint", () => {
      const plan = createSegmentedDownloadPlan({
        jobId: "job-idm-1",
        url: "https://cdn.example.com/ubuntu-24.04.iso",
        totalBytes: 8_000_000,
        maxConnections: 4,
        minSegmentBytes: 65_536,
      });

      expect(plan.segments).toHaveLength(4);
      expect(plan.segments[0]?.startByte).toBe(0);
      expect(plan.segments[0]?.endByte).toBe(1_999_999);
      expect(plan.segments[3]?.startByte).toBe(6_000_000);
      expect(plan.segments[3]?.endByte).toBe(7_999_999);

      // Advance segments 1, 2, 3 to completion, while segment 4 has only downloaded 400,000 bytes
      let activePlan = advanceSegmentProgress(plan, plan.segments[0]!.id, 2_000_000);
      activePlan = advanceSegmentProgress(activePlan, plan.segments[1]!.id, 2_000_000);
      activePlan = advanceSegmentProgress(activePlan, plan.segments[2]!.id, 2_000_000);
      activePlan = advanceSegmentProgress(activePlan, plan.segments[3]!.id, 400_000, 120_000);

      expect(activePlan.segments[0]?.status).toBe("completed");
      expect(activePlan.segments[3]?.currentByte).toBe(6_400_000);
      expect(activePlan.segments[3]?.remainingBytes).toBe(1_600_000);

      // Now trigger IDM work-stealing split on the slowest/largest remaining segment (#4)
      const splitOutcome = stealAndSplitSlowestSegment(activePlan, {
        minSplitBytes: 65_536,
      });

      expect(splitOutcome.didSplit).toBe(true);
      expect(splitOutcome.sourceSegmentId).toBe(plan.segments[3]!.id);
      // Remaining range was [6,400,000 .. 7,999,999] -> midpoint = 6,400,000 + floor(1,599,999 / 2) = 7,199,999
      expect(splitOutcome.splitMidpointByte).toBe(7_199_999);
      expect(splitOutcome.newSegment?.startByte).toBe(7_200_000);
      expect(splitOutcome.newSegment?.endByte).toBe(7_999_999);
      expect(splitOutcome.newSegment?.isStolenSplit).toBe(true);

      // Verify total bytes across all 5 segments still equals 8,000,000 with zero gaps or overlaps
      const updatedSegments = splitOutcome.plan.segments;
      expect(updatedSegments).toHaveLength(5);
      const sumTotalBytes = updatedSegments.reduce((acc, s) => acc + s.totalBytes, 0);
      expect(sumTotalBytes).toBe(8_000_000);
      for (let i = 1; i < updatedSegments.length; i += 1) {
        expect(updatedSegments[i]?.startByte).toBe(
          (updatedSegments[i - 1]?.endByte ?? 0) + 1,
        );
      }
    });

    it("merges byte-range segments losslessly, verifies contiguity, computes SHA-256, and detects container signature", () => {
      // PNG magic header (8 bytes) + 12 payload bytes = 20 bytes split across 3 segments
      const fullPayload = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
      ]);
      const expectedHash = computeBytesSha256Hex(fullPayload);

      const merged = mergeDownloadSegmentsLossless({
        mode: "byte-range",
        expectedTotalBytes: 20,
        expectedSha256Hex: expectedHash,
        segments: [
          { index: 2, startByte: 14, endByte: 19, data: fullPayload.slice(14, 20) },
          { index: 0, startByte: 0, endByte: 7, data: fullPayload.slice(0, 8) },
          { index: 1, startByte: 8, endByte: 13, data: fullPayload.slice(8, 14) },
        ],
      });

      expect(merged.isContiguous).toBe(true);
      expect(merged.totalBytes).toBe(20);
      expect(merged.segmentCount).toBe(3);
      expect(merged.containerFormat).toBe("PNG");
      expect(merged.sha256Hex).toBe(expectedHash);
      expect(merged.checksumVerified).toBe(true);
      expect(Array.from(merged.mergedBytes)).toEqual(Array.from(fullPayload));
    });

    it("rejects byte-range gaps or overlaps and merges HLS fMP4 segments with prepended EXT-X-MAP init segment", () => {
      expect(() =>
        mergeDownloadSegmentsLossless({
          mode: "byte-range",
          segments: [
            { index: 0, startByte: 0, endByte: 3, data: new Uint8Array([1, 2, 3, 4]) },
            { index: 1, startByte: 5, endByte: 7, data: new Uint8Array([6, 7, 8]) },
          ],
        }),
      ).toThrow(/gap detected/i);

      // HLS fMP4 merge with EXT-X-MAP init header ('ftyp' box)
      const initMap = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]);
      const seg100 = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const seg101 = new Uint8Array([0xdd, 0xee, 0xff]);

      const streamMerged = mergeDownloadSegmentsLossless({
        mode: "hls-stream",
        initSegment: initMap,
        segments: [
          { index: 1, sequenceNumber: 101, data: seg101 },
          { index: 0, sequenceNumber: 100, data: seg100 },
        ],
      });

      expect(streamMerged.prependedInitBytes).toBe(8);
      expect(streamMerged.totalBytes).toBe(14);
      expect(streamMerged.containerFormat).toBe("MP4/fMP4");
      expect(Array.from(streamMerged.mergedBytes)).toEqual([
        ...initMap,
        ...seg100,
        ...seg101,
      ]);

      expect(detectContainerFormatFromBytes(new Uint8Array([0x47, 0x40, 0x00]))).toBe(
        "MPEG-TS",
      );
      expect(
        detectContainerFormatFromBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
      ).toBe("WebM/MKV");
      expect(
        detectContainerFormatFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      ).toBe("ZIP");
      expect(detectContainerFormatFromBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
        "JPEG",
      );
    });
  });

  describe("8. Continuous Lookahead Buffer & Configurable Human-Like Seek Pacing (computeLookaheadBufferSchedule)", () => {
    it("schedules a 1-hour (3600s) video to complete in 6 minutes (360s) at 10x multiplier with stealth human scrub jitter", () => {
      const schedule = computeLookaheadBufferSchedule({
        streamDurationSec: 3600,
        totalSegments: 600,
        totalBytes: 1_500_000_000,
        config: DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
      });

      expect(schedule.streamDurationSec).toBe(3600);
      expect(schedule.estimatedDownloadDurationSec).toBe(360);
      expect(schedule.timeSavedSec).toBe(3240);
      expect(schedule.effectiveSpeedupMultiplier).toBe(10);
      expect(schedule.totalSeekBursts).toBe(100);
      expect(schedule.segmentsPerBurst).toBe(6);
      expect(schedule.cdnStealthAssessment).toBe("stealth-human-scrub");
      expect(schedule.deterministicBurstPlan.length).toBeGreaterThan(0);
      expect(schedule.DeterministicBurstPlan[0]?.segmentRange).toEqual([1, 6]);
      expect(schedule.DeterministicBurstPlan[0]?.jitterDelayMs).toBeGreaterThanOrEqual(140);
      expect(schedule.DeterministicBurstPlan[0]?.jitterDelayMs).toBeLessThanOrEqual(520);
    });

    it("supports custom advanced rate limiting and turbo-unthrottled mode", () => {
      const turbo = computeLookaheadBufferSchedule({
        streamDurationSec: 3600,
        totalSegments: 600,
        totalBytes: 600_000_000,
        config: {
          ...DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
          mode: "turbo-unthrottled",
          seekSpeedMultiplier: 30,
        },
      });
      expect(turbo.estimatedDownloadDurationSec).toBe(120);
      expect(turbo.cdnStealthAssessment).toBe("aggressive-burst");

      const rateCapped = computeLookaheadBufferSchedule({
        streamDurationSec: 3600,
        totalSegments: 600,
        totalBytes: 1024 * 1000, // 1000 KB
        config: {
          ...DEFAULT_STREAM_LOOKAHEAD_PACING_CONFIG,
          mode: "custom-advanced",
          seekSpeedMultiplier: 20, // would be 180s
          customRateLimitKbps: 2, // 1000 KB / 2 KB/s = 500s
        },
      });
      expect(rateCapped.estimatedDownloadDurationSec).toBe(500);
    });
  });

  describe("9. Universal Cloud & View-Only Media/Document Extractor (resolveUniversalCloudMediaUrl)", () => {
    it("resolves Google Drive, Google Docs, OneDrive/SharePoint, Dropbox, GitHub, and View-Only Canvas PDF links", () => {
      const gdrive = resolveUniversalCloudMediaUrl(
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing",
        { preferredQuality: "4k-2160p", preferredDpi: 600 },
      );
      expect(gdrive.provider).toBe("google-drive");
      expect(gdrive.resourceId).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
      expect(gdrive.directDownloadUrl).toContain("confirm=t");
      expect(gdrive.highDpiPdfExportUrl).toContain("dpi=600");
      expect(gdrive.availableQualities).toHaveLength(6);
      expect(gdrive.requiresSessionCookies).toBe(true);

      const gdocs = resolveUniversalCloudMediaUrl(
        "https://docs.google.com/document/d/1DocExportId999/edit",
        { preferredDpi: 1200 },
      );
      expect(gdocs.provider).toBe("google-docs-export");
      expect(gdocs.resourceId).toBe("1DocExportId999");
      expect(gdocs.highDpiPdfExportUrl).toContain("dpi=1200");
      expect(gdocs.inferredFilename).toContain("1200dpi.pdf");

      const onedrive = resolveUniversalCloudMediaUrl(
        "https://contoso-my.sharepoint.com/:v:/g/personal/user/EShareToken12345?e=abc",
        { preferredQuality: "1080p-fhd", preferredDpi: 300 },
      );
      expect(onedrive.provider).toBe("onedrive-sharepoint");
      expect(onedrive.directDownloadUrl).toContain("download=1");
      expect(onedrive.authenticatedStreamUrl).toContain("quality=1080p");

      const dropbox = resolveUniversalCloudMediaUrl(
        "https://www.dropbox.com/s/xyz987654/lecture-notes.pdf?dl=0",
      );
      expect(dropbox.provider).toBe("dropbox");
      expect(dropbox.directDownloadUrl).toContain("dl.dropboxusercontent.com");
      expect(dropbox.directDownloadUrl).toContain("dl=1");
    });
  });

  describe("10. Ultra-High-DPI (150 / 300 / 600 / 1200 DPI) Multi-Page PDF Reconstructor (assembleHighDpiDocumentPdf)", () => {
    it("generates standards-compliant %PDF-1.7 binaries with exact A4 pixel geometry for 150, 300, 600, and 1200 DPI", () => {
      const pdf150 = assembleHighDpiDocumentPdf({
        title: "Draft Spec",
        sourceUrl: "https://drive.google.com/file/d/draft/view",
        dpi: 150,
        pageCount: 2,
      });
      expect(pdf150.pixelWidth).toBe(1240);
      expect(pdf150.pixelHeight).toBe(1754);
      expect(pdf150.containerFormat).toBe("PDF");

      const pdf300 = assembleHighDpiDocumentPdf({
        title: "Print Spec",
        sourceUrl: "https://drive.google.com/file/d/print/view",
        dpi: 300,
        pageCount: 2,
      });
      expect(pdf300.pixelWidth).toBe(2480);
      expect(pdf300.pixelHeight).toBe(3508);

      const pdf600 = assembleHighDpiDocumentPdf({
        title: "Omnia Archival Whitepaper",
        sourceUrl: "https://docs.google.com/document/d/whitepaper/view",
        dpi: 600,
        pageCount: 3,
      });
      expect(pdf600.pixelWidth).toBe(4960);
      expect(pdf600.pixelHeight).toBe(7016);
      expect(pdf600.pageCount).toBe(3);
      expect(pdf600.filename).toBe("omnia-archival-whitepaper-600dpi.pdf");

      const pdf1200 = assembleHighDpiDocumentPdf({
        title: "Ultra Master Blueprint",
        sourceUrl: "https://onedrive.live.com/view.aspx?resid=1200",
        dpi: 1200,
        pageCount: 4,
      });
      expect(pdf1200.pixelWidth).toBe(9921);
      expect(pdf1200.pixelHeight).toBe(14031);
      expect(pdf1200.containerFormat).toBe("PDF");
      expect(pdf1200.sha256Hex).toBe(computeBytesSha256Hex(pdf1200.pdfBytes));

      const decodedText = new TextDecoder().decode(pdf1200.pdfBytes);
      expect(decodedText.startsWith("%PDF-1.7")).toBe(true);
      expect(decodedText).toContain("/Type /Catalog");
      expect(decodedText).toContain("/Type /Pages");
      expect(decodedText).toContain("/MediaBox [0 0 9921 14031]");
      expect(decodedText).toContain("xref");
      expect(decodedText).toContain("trailer");
      expect(decodedText.trim().endsWith("%%EOF")).toBe(true);
    });
  });
});

