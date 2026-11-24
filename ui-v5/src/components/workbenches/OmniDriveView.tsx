import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Activity,
  Download,
  Film,
  Pause,
  Play,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';

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
  const [mediaProbeResult, setMediaProbeResult] = createSignal<Record<string, unknown> | null>(null);
  const [driftResult, setDriftResult] = createSignal<Record<string, unknown> | null>(null);
  const [crawlKind, setCrawlKind] = createSignal<'moodle' | 'youtube' | 'web'>('web');
  const [statusMsg, setStatusMsg] = createSignal('');

  let waveCanvasRef: HTMLCanvasElement | undefined;
  let rafId = 0;

  const selectedJob = createMemo(
    () => jobs().find((j) => String(j.id ?? j.job_id) === selectedJobId()) ?? jobs()[0] ?? null,
  );

  const cellFractions = createMemo(() => {
    const j = selectedJob();
    if (!j) return new Array<number>(128).fill(0);
    const total = Number(j.total_bytes ?? j.totalBytes ?? 0);
    const segs = Array.isArray(j.segments)
      ? (j.segments as Array<Record<string, unknown>>).map((s) => ({
          start: Number(s.start_byte ?? s.start ?? 0),
          end: Number(s.end_byte ?? s.end ?? 0),
          downloaded: Number(s.downloaded_bytes ?? s.downloaded ?? 0),
        }))
      : [];
    return compute128CellFractions(total, segs);
  });

  const refreshJobs = async () => {
    const res = await api.listDownloads();
    if (res.ok && Array.isArray(res.data.jobs)) {
      setJobs(res.data.jobs);
      const totalBps = res.data.jobs.reduce((acc, j) => acc + Number(j.speed_bps ?? j.speedBps ?? 0), 0);
      setSpeedSamples((prev) => [...prev.slice(-47), totalBps]);
    }
  };

  onMount(() => {
    void refreshJobs();
    const timer = setInterval(() => void refreshJobs(), 1200);

    const drawWave = () => {
      if (waveCanvasRef) {
        const ctx = waveCanvasRef.getContext('2d');
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          const w = waveCanvasRef.clientWidth;
          const h = waveCanvasRef.clientHeight;
          if (waveCanvasRef.width !== w * dpr) {
            waveCanvasRef.width = w * dpr;
            waveCanvasRef.height = h * dpr;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);

          const cs = getComputedStyle(document.documentElement);
          const mutedLine = cs.getPropertyValue('--border-subtle').trim() || 'rgba(142, 155, 178, 0.25)';
          const accentLine = cs.getPropertyValue('--accent-cyan').trim() || '#38BDF8';

          // Baseline grid
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
        }
      }
      rafId = requestAnimationFrame(drawWave);
    };
    rafId = requestAnimationFrame(drawWave);

    onCleanup(() => {
      clearInterval(timer);
      cancelAnimationFrame(rafId);
    });
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

  return (
    <div data-testid="omnidrive-workbench" class="flex-1 min-h-0 flex flex-col overflow-y-auto p-4 gap-4 bg-[var(--bg-canvas)]">
      {/* Transfer Launcher */}
      <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 font-bold text-[14px]">
            <Download class="w-4 h-4 text-[var(--accent-cyan)]" />
            <span>OmniDrive Pro — Multi-Stream & HLS/DASH Engine</span>
          </div>
          <Show when={statusMsg()}>
            <span class="text-[11.5px] font-mono-num text-[var(--accent-amber)]">{statusMsg()}</span>
          </Show>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="https://... (HTTP, Google Drive, Moodle, HLS .m3u8, DASH .mpd)"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            class="flex-1 min-w-[240px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12.5px] font-mono-num outline-none"
          />
          <select
            value={streams()}
            onChange={(e) => setStreams(Number(e.currentTarget.value))}
            class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
          >
            {[1, 4, 8, 12, 16].map((n) => <option value={n}>{n} streams</option>)}
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
            onClick={() => void api.crawlUrl(crawlKind(), url()).then((r) => setStatusMsg(r.ok ? 'Crawl finished' : r.error.message))}
          >
            <Search class="w-3.5 h-3.5" />
            <span>Crawl</span>
          </button>
          <button
            type="button"
            class="omnia-btn text-[12px]"
            onClick={() => void api.probeMedia(url()).then((r) => r.ok && setMediaProbeResult(r.data))}
          >
            <Film class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
            <span>FFprobe</span>
          </button>
          <button type="button" class="omnia-btn text-[12px]" onClick={() => void refreshJobs()}>
            <RefreshCw class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 60fps Bezier Speed Wave + 128-Chunk Live Heatmap */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="omnia-surface-panel rounded-lg p-3.5">
          <div class="flex items-center justify-between mb-2 text-[12px]">
            <span class="font-semibold flex items-center gap-1.5">
              <Activity class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span>60fps Bezier Throughput Wave</span>
            </span>
            <span class="font-mono-num text-[var(--ink-muted)]">
              {(speedSamples()[speedSamples().length - 1] / 1024).toFixed(1)} KiB/s
            </span>
          </div>
          <canvas ref={waveCanvasRef} class="w-full h-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5">
          <div class="flex items-center justify-between mb-2 text-[12px]">
            <span class="font-semibold">128-Chunk Live Interval Map</span>
            <span class="font-mono-num text-[var(--ink-muted)]">
              {selectedJob() ? String(selectedJob()!.filename || selectedJob()!.id) : 'No active transfer'}
            </span>
          </div>
          <div class="grid grid-cols-16 gap-1 p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
            <For each={cellFractions()}>
              {(frac, idx) => (
                <div
                  title={`Chunk ${idx()}: ${(frac * 100).toFixed(0)}%`}
                  class="h-3 rounded-[2px] border border-[var(--border-subtle)]"
                  style={{
                    'background-color': frac > 0.9 ? 'var(--status-emerald)' : frac > 0 ? 'var(--accent-cyan)' : 'var(--bg-panel)',
                  }}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Active Jobs List + Schema Drift / FFprobe Inspector */}
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <div class="omnia-surface-panel rounded-lg p-3.5">
          <div class="font-semibold text-[12.5px] mb-2">Download Queue ({jobs().length})</div>
          <div class="space-y-2">
            <For each={jobs()}>
              {(job) => {
                const jid = String(job.id ?? job.job_id);
                return (
                  <div
                    onClick={() => setSelectedJobId(jid)}
                    class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div class="min-w-0">
                      <div class="text-[12.5px] font-semibold truncate">{String(job.filename || job.url || jid)}</div>
                      <div class="text-[11px] font-mono-num text-[var(--ink-muted)]">
                        {String(job.status || 'queued')} · {String(job.downloaded_bytes ?? 0)} / {String(job.total_bytes ?? '?')} B
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <button type="button" class="omnia-btn px-2 py-1 text-[11px]" onClick={() => void api.pauseDownload(jid)}>
                        <Pause class="w-3 h-3" />
                      </button>
                      <button type="button" class="omnia-btn omnia-btn-danger px-2 py-1 text-[11px]" onClick={() => void api.cancelDownload(jid)}>
                        <XCircle class="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 text-[12px]">
          <div class="flex items-center justify-between">
            <span class="font-semibold">SchemaDrift & Media Probe</span>
            <button type="button" class="omnia-btn px-2 py-0.5 text-[11px]" onClick={() => void api.listSchemaDrift().then((r) => r.ok && setDriftResult(r.data))}>
              Check Drift
            </button>
          </div>
          <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-48 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(mediaProbeResult() ?? driftResult() ?? { status: 'Ready' }, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
