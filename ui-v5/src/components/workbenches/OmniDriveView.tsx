import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Activity,
  Database,
  Download,
  Film,
  PackageCheck,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask, themePref } from '@/state/studio';
import { maskJson } from '@/utils/privacy';
import { formatBytes } from '@/utils/stats';

/**
 * Compute 128-cell proportional completion fractions from downloaded byte segments
 * matching OmniDrive Studio v3 bitmap spec.
 */
export function compute128CellFractions(
  totalBytes: number,
  segments: Array<{ start: number; end: number; downloaded: number }>,
): number[] {
  const cells = new Array<number>(128).fill(0);
  if (totalBytes <= 0 || segments.length === 0) return cells;
  const cellSize = totalBytes / 128;
  for (let i = 0; i < 128; i++) {
    const cStart = i * cellSize;
    const cEnd = (i + 1) * cellSize;
    let covered = 0;
    for (const seg of segments) {
      const doneEnd = Math.min(seg.end, seg.start + seg.downloaded);
      const overlap = Math.max(0, Math.min(cEnd, doneEnd) - Math.max(cStart, seg.start));
      covered += overlap;
    }
    cells[i] = Math.min(1, covered / Math.max(cellSize, 1));
  }
  return cells;
}

export function OmniDriveView() {
  const [url, setUrl] = createSignal('');
  const [streams, setStreams] = createSignal(8);
  const [pacing, setPacing] = createSignal('adaptive');
  const [jobs, setJobs] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedJobId, setSelectedJobId] = createSignal<string | null>(null);
  const [speedSamples, setSpeedSamples] = createSignal<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const [inspectorPayload, setInspectorPayload] = createSignal<Record<string, unknown> | null>(null);
  const [crawlKind, setCrawlKind] = createSignal<'moodle' | 'youtube' | 'web'>('web');
  const [muxVideo, setMuxVideo] = createSignal('');
  const [muxAudio, setMuxAudio] = createSignal('');
  const [statusMsg, setStatusMsg] = createSignal('');

  let waveCanvasRef: HTMLCanvasElement | undefined;

  const selectedJob = createMemo(
    () => jobs().find((j) => String(j.id ?? j.job_id) === selectedJobId()) ?? jobs()[0] ?? null,
  );

  const selectedSegments = createMemo(() => {
    const j = selectedJob();
    if (!j || !Array.isArray(j.segments)) return [];
    return (j.segments as Array<Record<string, unknown>>).map((s, idx) => ({
      idx,
      start: Number(s.start_byte ?? s.start ?? 0),
      end: Number(s.end_byte ?? s.end ?? 0),
      downloaded: Number(s.downloaded_bytes ?? s.downloaded ?? 0),
      state: String(s.state ?? s.status ?? 'active'),
    }));
  });

  const cellFractions = createMemo(() => {
    const j = selectedJob();
    if (!j) return new Array<number>(128).fill(0);
    const total = Number(j.total_bytes ?? j.totalBytes ?? 0);
    return compute128CellFractions(total, selectedSegments());
  });

  const drawWaveOnce = () => {
    if (!waveCanvasRef) return;
    const ctx = waveCanvasRef.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = waveCanvasRef.clientWidth || 320;
    const h = waveCanvasRef.clientHeight || 112;
    if (waveCanvasRef.width !== Math.round(w * dpr) || waveCanvasRef.height !== Math.round(h * dpr)) {
      waveCanvasRef.width = Math.round(w * dpr);
      waveCanvasRef.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(document.documentElement);
    const mutedLine = cs.getPropertyValue('--border-subtle').trim() || 'rgba(142, 155, 178, 0.25)';
    const accentLine = cs.getPropertyValue('--accent-cyan').trim() || '#38BDF8';

    ctx.strokeStyle = mutedLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    const samples = speedSamples();
    const maxBps = Math.max(1024 * 1024, ...samples);
    ctx.strokeStyle = accentLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = (i / Math.max(samples.length - 1, 1)) * w;
      const y = h - 8 - (samples[i] / maxBps) * (h - 16);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = ((i - 1) / Math.max(samples.length - 1, 1)) * w;
        const prevY = h - 8 - (samples[i - 1] / maxBps) * (h - 16);
        const midX = (prevX + x) / 2;
        ctx.bezierCurveTo(midX, prevY, midX, y, x, y);
      }
    }
    ctx.stroke();
  };

  const refreshJobs = async () => {
    const res = await api.listDownloads();
    if (res.ok && Array.isArray(res.data.jobs)) {
      setJobs(res.data.jobs);
      const totalBps = res.data.jobs.reduce((acc, j) => acc + Number(j.speed_bps ?? j.speedBps ?? 0), 0);
      setSpeedSamples((prev) => [...prev.slice(-47), totalBps]);
    }
  };

  // Event-driven redraw (zero idle 60fps CPU burn!)
  createEffect(() => {
    speedSamples();
    themePref();
    drawWaveOnce();
  });

  onMount(() => {
    void refreshJobs();
    const timer = setInterval(() => void refreshJobs(), 2000);
    onCleanup(() => clearInterval(timer));
  });

  const handleStart = async () => {
    if (!url().trim()) return;
    const res = await api.startDownload(url().trim(), streams(), pacing());
    if (res.ok) {
      setStatusMsg(`Queued job ${String(res.data.job_id ?? '')}`);
      setUrl('');
      await refreshJobs();
    } else {
      setStatusMsg(`Download blocked (${res.error.code}): ${res.error.message}`);
    }
  };

  const handlePause = async (jid: string) => {
    const res = await api.pauseDownload(jid);
    setStatusMsg(res.ok ? `Paused ${jid}` : `Pause error (${res.error.code}): ${res.error.message}`);
    await refreshJobs();
  };

  const handleCancel = async (jid: string) => {
    const res = await api.cancelDownload(jid);
    setStatusMsg(res.ok ? `Cancelled ${jid}` : `Cancel error (${res.error.code}): ${res.error.message}`);
    await refreshJobs();
  };

  const handleSealBundle = async () => {
    const res = await api.sealCaptureBundle(url().trim() || 'https://example.com', [
      { name: 'manifest.txt', text: `OmniDrive sealed bundle at ${new Date().toISOString()}` },
    ]);
    if (res.ok) {
      setInspectorPayload(res.data);
      setStatusMsg('Sealed SHA-256 Capture Bundle');
    } else {
      setStatusMsg(`Bundle error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleMux = async () => {
    if (!muxVideo().trim() || !muxAudio().trim()) {
      setStatusMsg('Enter both video and audio paths for FFmpeg mux');
      return;
    }
    const res = await api.muxMedia(muxVideo().trim(), muxAudio().trim(), 'D:\\OmniaData\\tmp\\omnia-muxed.mp4');
    if (res.ok) {
      setInspectorPayload(res.data);
      setStatusMsg('FFmpeg mux completed');
    } else {
      setInspectorPayload({ error: res.error.code, message: res.error.message });
      setStatusMsg(`FFmpeg mux (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="omnidrive-workbench" class="flex-1 min-h-0 flex flex-col overflow-y-auto p-4 gap-4 bg-[var(--bg-canvas)]">
      {/* Transfer Launcher */}
      <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 font-bold text-[14px]">
            <Download class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>OmniDrive Pro — Multi-Stream, WAL, SHA-256 & HLS/DASH Engine</span>
            <span class="omnia-badge text-[var(--status-emerald)] font-mono-num">
              <Database class="w-3 h-3" />
              <span>SQLite WAL</span>
            </span>
          </div>
          <Show when={statusMsg()}>
            <span class="text-[11.5px] font-mono-num text-[var(--accent-amber)]">{statusMsg()}</span>
          </Show>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="https://example.com/archive.bin (HTTP, Google Drive, Moodle, HLS .m3u8, DASH .mpd)"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            class="flex-1 min-w-[240px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono-num outline-none"
          />
          <select
            value={streams()}
            onChange={(e) => setStreams(Number(e.currentTarget.value))}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
          >
            {[1, 4, 8, 12, 16].map((n) => (
              <option value={n}>{n} streams</option>
            ))}
          </select>
          <select
            value={pacing()}
            onChange={(e) => setPacing(e.currentTarget.value)}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
          >
            <option value="adaptive">Adaptive Pacing</option>
            <option value="aggressive">Aggressive</option>
            <option value="polite">Polite</option>
            <option value="capped">Bandwidth Capped</option>
          </select>
          <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleStart()}>
            <Play class="w-3.5 h-3.5" />
            <span>Start Transfer</span>
          </button>
          <select
            value={crawlKind()}
            onChange={(e) => setCrawlKind(e.currentTarget.value as 'moodle' | 'youtube' | 'web')}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
          >
            <option value="web">Web Crawl</option>
            <option value="moodle">Moodle Crawl</option>
            <option value="youtube">YouTube/Transcript</option>
          </select>
          <button
            type="button"
            class="omnia-btn text-[12px]"
            onClick={async () => {
              const r = await api.crawlUrl(crawlKind(), url());
              if (r.ok) {
                setInspectorPayload(r.data);
                setStatusMsg(`Crawl (${crawlKind()}) finished`);
              } else {
                setInspectorPayload({ error: r.error.code, message: r.error.message });
                setStatusMsg(`Crawl (${r.error.code}): ${r.error.message}`);
              }
            }}
          >
            <Search class="w-3.5 h-3.5" />
            <span>Crawl</span>
          </button>
          <button
            type="button"
            class="omnia-btn text-[12px]"
            onClick={async () => {
              const r = await api.probeMedia(url());
              if (r.ok) {
                setInspectorPayload(r.data);
                setStatusMsg('FFprobe inspected media');
              } else {
                setInspectorPayload({ error: r.error.code, message: r.error.message });
                setStatusMsg(`FFprobe (${r.error.code}): ${r.error.message}`);
              }
            }}
          >
            <Film class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
            <span>FFprobe</span>
          </button>
          <button type="button" class="omnia-btn text-[12px]" onClick={() => void refreshJobs()}>
            <RefreshCw class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Bezier Throughput Wave + 128-Chunk Live Heatmap + Per-Chunk Bars */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="omnia-surface-panel rounded-lg p-3.5">
          <div class="flex items-center justify-between mb-2 text-[12px]">
            <span class="font-semibold flex items-center gap-1.5">
              <Activity class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>Bezier Throughput Wave (Event-Driven)</span>
            </span>
            <span class="font-mono-num text-[var(--ink-muted)]">
              {(speedSamples()[speedSamples().length - 1] / 1024).toFixed(1)} KiB/s
            </span>
          </div>
          <canvas ref={waveCanvasRef} class="w-full h-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
          <div class="flex items-center justify-between text-[12px]">
            <span class="font-semibold">128-Chunk Bitmap & Per-Stream Bars</span>
            <span class="font-mono-num text-[var(--ink-muted)] truncate max-w-[200px]">
              {selectedJob() ? String(selectedJob()!.filename || selectedJob()!.id) : 'No active transfer'}
            </span>
          </div>
          <div
            class="grid gap-1 p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]"
            style={{ 'grid-template-columns': 'repeat(16, minmax(0, 1fr))' }}
          >
            <For each={cellFractions()}>
              {(frac, idx) => (
                <div
                  title={`Chunk ${idx()}: ${(frac * 100).toFixed(0)}%`}
                  class="h-2.5 rounded-[2px] border border-[var(--border-subtle)]"
                  style={{
                    'background-color':
                      frac > 0.9 ? 'var(--status-emerald)' : frac > 0 ? 'var(--accent-cyan)' : 'var(--bg-panel)',
                  }}
                />
              )}
            </For>
          </div>
          <Show when={selectedSegments().length > 0}>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10.5px] font-mono-num">
              <For each={selectedSegments().slice(0, 8)}>
                {(seg) => {
                  const len = Math.max(1, seg.end - seg.start);
                  const pct = Math.min(100, (seg.downloaded / len) * 100);
                  return (
                    <div class="p-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-1">
                      <div class="flex justify-between">
                        <span>S{seg.idx}</span>
                        <span>{pct.toFixed(0)}%</span>
                      </div>
                      <div class="w-full h-1.5 rounded bg-[var(--bg-panel)] overflow-hidden">
                        <div class="h-full bg-[var(--status-emerald)]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Active Jobs List + SchemaDrift / FFmpeg Mux / Capture Bundles */}
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
        <div class="omnia-surface-panel rounded-lg p-3.5">
          <div class="font-semibold text-[12.5px] mb-2">Download Queue ({jobs().length})</div>
          <div class="space-y-2">
            <Show
              when={jobs().length > 0}
              fallback={
                <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                  No queued transfers yet. Paste a URL above to test multi-stream Range/HLS/DASH transfers with SQLite WAL persistence.
                </div>
              }
            >
              <For each={jobs()}>
                {(job) => {
                  const jid = String(job.id ?? job.job_id);
                  const sha = String(job.sha256 ?? '');
                  return (
                    <div
                      onClick={() => setSelectedJobId(jid)}
                      class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <div class="min-w-0 space-y-0.5">
                        <div class="text-[12.5px] font-semibold truncate">{String(job.filename || job.url || jid)}</div>
                        <div class="text-[11px] font-mono-num text-[var(--ink-muted)] flex flex-wrap gap-2">
                          <span>{String(job.status || 'queued')}</span>
                          <span>
                            {formatBytes(Number(job.downloaded_bytes ?? 0))} /{' '}
                            {job.total_bytes ? formatBytes(Number(job.total_bytes)) : '?'}
                          </span>
                          <Show when={sha}>
                            <span class="text-[var(--status-emerald)] flex items-center gap-1">
                              <ShieldCheck class="w-3 h-3" />
                              sha256:{sha.slice(0, 10)}
                            </span>
                          </Show>
                        </div>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handlePause(jid)}>
                          <Pause class="w-3 h-3" />
                        </button>
                        <button type="button" class="omnia-btn omnia-btn-danger px-2 py-1 text-[11px]" onClick={() => void handleCancel(jid)}>
                          <XCircle class="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5 text-[12px]">
          <div class="flex flex-wrap items-center justify-between gap-1.5">
            <span class="font-semibold">SchemaDrift, FFmpeg Mux & Capture Bundles</span>
            <div class="flex gap-1">
              <button
                type="button"
                class="omnia-btn px-2 py-0.5 text-[11px]"
                onClick={async () => {
                  const r = await api.listSchemaDrift();
                  setInspectorPayload(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                  setStatusMsg(r.ok ? 'Checked schema_drift' : `SchemaDrift (${r.error.code})`);
                }}
              >
                Check Drift
              </button>
              <button type="button" class="omnia-btn px-2 py-0.5 text-[11px]" onClick={() => void handleSealBundle()}>
                <PackageCheck class="w-3 h-3 text-[var(--status-emerald)]" />
                <span>Seal Bundle</span>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-1.5 text-[11px]">
            <input
              type="text"
              placeholder="Video stream path..."
              value={muxVideo()}
              onInput={(e) => setMuxVideo(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
            />
            <input
              type="text"
              placeholder="Audio stream path..."
              value={muxAudio()}
              onInput={(e) => setMuxAudio(e.currentTarget.value)}
              class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
            />
            <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void handleMux()}>
              FFmpeg Mux
            </button>
          </div>

          <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-48 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(maskJson(inspectorPayload() ?? { status: 'Ready' }, privacyMask()), null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
