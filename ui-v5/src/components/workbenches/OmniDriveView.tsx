import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  Activity,
  Binary,
  Clock,
  Cookie,
  Database,
  Download,
  ExternalLink,
  FileCheck2,
  Film,
  FolderTree,
  Globe,
  Layers,
  PackageCheck,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  XCircle,
} from 'lucide-solid';
import { api } from '@/api/client';
import { privacyMask, themePref } from '@/state/studio';
import { downloadTextFile, maskJson, maskText } from '@/utils/privacy';
import { formatBytes } from '@/utils/stats';

type DriveStudioTab = 'transfers' | 'integrity' | 'handoff' | 'protocol';

interface PlannedBatchItem {
  url: string;
  canonicalUrl: string;
  provider: string;
  category: string;
  folder: string;
  filename: string;
  deduped: boolean;
}

interface SiteCapRule {
  host_pattern: string;
  max_connections_per_host: number;
  default_pacing: string;
  note: string;
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_reader',
  'utm_name',
  'fbclid',
  'gclid',
  'dclid',
  'yclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  '_ga',
  '_gl',
  'spm',
  'ref_src',
  'si',
]);

const PROVIDER_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: '', label: 'All 10 Categories' },
  { value: 'cloud_storage', label: 'Cloud Storage' },
  { value: 'workspace_docs', label: 'Workspace Docs' },
  { value: 'object_storage', label: 'Object Storage' },
  { value: 'cdn_edge', label: 'CDN Edge' },
  { value: 'code_hosting', label: 'Code Hosting' },
  { value: 'ai_datasets', label: 'AI Datasets' },
  { value: 'academic_lms', label: 'Academic / LMS' },
  { value: 'package_registry', label: 'Package Registry' },
  { value: 'streaming_manifest', label: 'Streaming Manifest' },
  { value: 'direct_http', label: 'Direct HTTP' },
];

const MEDIA_HEX_PRESETS: Record<'fmp4' | 'pssh' | 'mpegts' | 'adts', string> = {
  fmp4: '000000186674797069736f6d0000020069736f6d69736f320000000866726565',
  pssh: '000000186674797069736f6d0000020069736f6d64617368000000207073736800000000edef8ba979d64acea3c827dcd51d21ed00000000',
  mpegts: '474011100000b00d0001c100000001e1002ab104b2',
  adts: 'fff15080021ffcde04004c617663',
};

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

function stripTrackingParamsRaw(rawUrl: string): string {
  const hashIdx = rawUrl.indexOf('#');
  const beforeFrag = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
  const qIdx = beforeFrag.indexOf('?');
  if (qIdx < 0) return beforeFrag;
  const base = beforeFrag.slice(0, qIdx);
  const query = beforeFrag.slice(qIdx + 1);
  const kept = query
    .split('&')
    .filter((seg) => {
      if (!seg) return false;
      const eq = seg.indexOf('=');
      const key = (eq >= 0 ? seg.slice(0, eq) : seg).toLowerCase();
      return !TRACKING_PARAMS.has(key) && !key.startsWith('utm_');
    });
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
}

function detectSeriesFolder(filename: string): string | null {
  const stem = filename.replace(/\.[^./\\]+$/, '').trim();
  if (!stem) return null;
  const low = stem.toLowerCase();
  const markers = [' - ep ', ' - ep.', ' ep ', ' episode ', ' - tap ', ' tap ', ' s01e', ' s02e', ' s03e', '.s01e', '_s01e'];
  let cut = -1;
  for (const m of markers) {
    const pos = low.indexOf(m);
    if (pos >= 2 && (cut < 0 || pos < cut)) cut = pos;
  }
  if (cut < 2) return null;
  const cleaned = stem.slice(0, cut).replace(/^[\s\-_.[\]()]+|[\s\-_.[\]()]+$/g, '');
  return cleaned.length >= 2 ? cleaned : null;
}

function classifyExtCategory(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'ipynb'].includes(ext)) return 'Documents';
  if (['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz'].includes(ext)) return 'Compressed';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext)) return 'Music';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'm3u8', 'mpd'].includes(ext)) return 'Video';
  if (['exe', 'msi', 'msix', 'dmg', 'pkg', 'deb', 'rpm', 'whl'].includes(ext)) return 'Programs';
  return 'General';
}

function inferProviderName(rawUrl: string): string {
  const low = rawUrl.toLowerCase();
  if (low.includes('.m3u8')) return 'hls_m3u8';
  if (low.includes('.mpd')) return 'dash_mpd';
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes('drive.google.com') || host.includes('googleapis.com')) return 'google_drive';
    if (host.includes('docs.google.com')) return 'google_docs';
    if (host.includes('github.com') || host.includes('githubusercontent.com')) return 'github_releases';
    if (host.includes('huggingface.co') || host.includes('hf.co')) return 'huggingface_hub';
    if (host.includes('arxiv.org')) return 'arxiv';
    if (host.includes('moodle')) return 'moodle_lms';
    if (host.includes('dropbox')) return 'dropbox';
    if (host.includes('s3.amazonaws.com')) return 'aws_s3';
    if (host.includes('storage.googleapis.com')) return 'gcs';
    if (host.includes('cloudfront.net')) return 'cloudfront';
    if (host.includes('r2.dev') || host.includes('r2.cloudflarestorage.com')) return 'cloudflare_r2';
    if (host.includes('pypi.org') || host.includes('pythonhosted.org')) return 'pypi';
    if (host.includes('registry.npmjs.org')) return 'npm_registry';
  } catch {
    // ignore malformed URL
  }
  return 'generic_http';
}

function extractLocalBatchPlan(
  rawText: string,
  autoGroupSeries: boolean,
  categorizeSubfolders: boolean,
): { extracted: number; unique: number; deduped: number; folders: number; items: PlannedBatchItem[] } {
  const matches = rawText.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  const expanded: string[] = [];
  for (const m of matches) {
    const clean = m.replace(/[.,;]+$/, '');
    const rangeMatch = clean.match(/\[(\d+)-(\d+)\]/);
    if (rangeMatch) {
      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      const pad = startStr.startsWith('0') && startStr.length > 1 ? startStr.length : 0;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end - start <= 100) {
        for (let i = start; i <= end; i++) {
          const tok = pad > 0 ? String(i).padStart(pad, '0') : String(i);
          expanded.push(clean.replace(rangeMatch[0], tok));
        }
        continue;
      }
    }
    expanded.push(clean);
  }
  const seen = new Set<string>();
  const items: PlannedBatchItem[] = [];
  const folderSet = new Set<string>();
  let deduped = 0;
  for (const raw of expanded) {
    const canonical = stripTrackingParamsRaw(raw);
    const isDup = seen.has(canonical);
    if (isDup) {
      deduped += 1;
      continue;
    }
    seen.add(canonical);
    const pathPart = canonical.split('?')[0];
    const filename = decodeURIComponent(pathPart.split('/').pop() || 'download.bin');
    const category = classifyExtCategory(filename);
    const series = autoGroupSeries ? detectSeriesFolder(filename) : null;
    const folder = series ? `${category}/${series}` : categorizeSubfolders ? category : 'Staging';
    folderSet.add(folder);
    items.push({
      url: raw,
      canonicalUrl: canonical,
      provider: inferProviderName(canonical),
      category,
      folder,
      filename,
      deduped: false,
    });
  }
  return {
    extracted: expanded.length,
    unique: items.length,
    deduped,
    folders: folderSet.size,
    items,
  };
}

function formatEf2Local(urls: string[]): string {
  return urls
    .map((u) => {
      const clean = stripTrackingParamsRaw(u.trim());
      const fname = clean.split('?')[0].split('/').pop() || 'item.bin';
      return `<\n${clean}\nfilename: ${fname}\n>`;
    })
    .join('\n');
}

export function OmniDriveView() {
  const [studioTab, setStudioTab] = createSignal<DriveStudioTab>('transfers');

  // Tab 1: Transfers, Batch Link Planner, .EF2 & Scheduler
  const [url, setUrl] = createSignal('');
  const [streams, setStreams] = createSignal(8);
  const [pacing, setPacing] = createSignal('adaptive');
  const [jobs, setJobs] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedJobId, setSelectedJobId] = createSignal<string | null>(null);
  const [speedSamples, setSpeedSamples] = createSignal<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const [crawlKind, setCrawlKind] = createSignal<'moodle' | 'youtube' | 'web'>('web');
  const [batchInput, setBatchInput] = createSignal(
    'See [Release Pack](https://downloads.example.org/archive-[01-03].tar.gz?utm_source=digest&fbclid=demo123)\nhttps://downloads.example.org/archive-01.tar.gz?utm_medium=mirror\n<a href="https://downloads.example.org/Rust_Systems_Course_-_Ep_04.mp4?si=track">Lecture 4</a>',
  );
  const [batchItems, setBatchItems] = createSignal<PlannedBatchItem[]>([]);
  const [batchKpi, setBatchKpi] = createSignal({ extracted: 0, unique: 0, deduped: 0, folders: 0 });
  const [batchResult, setBatchResult] = createSignal<Record<string, unknown> | null>(null);
  const [ef2Text, setEf2Text] = createSignal('');
  const [autoGroupSeries, setAutoGroupSeries] = createSignal(true);
  const [categorizeSubfolders, setCategorizeSubfolders] = createSignal(true);
  const [schedulerMaxConcurrent, setSchedulerMaxConcurrent] = createSignal(3);
  const [schedulerStartUtc, setSchedulerStartUtc] = createSignal(0);
  const [schedulerEndUtc, setSchedulerEndUtc] = createSignal(24);
  const [schedulerState, setSchedulerState] = createSignal<Record<string, unknown> | null>(null);
  const [manifestProbeBusy, setManifestProbeBusy] = createSignal(false);
  const [manifestTracks, setManifestTracks] = createSignal<{
    kind: string;
    sourceUrl: string;
    video: Array<{ id: string; label: string; url: string }>;
    audio: Array<{ id: string; label: string; url: string }>;
    subtitles: Array<{ id: string; label: string; url: string }>;
  } | null>(null);
  const [selectedVideoTrack, setSelectedVideoTrack] = createSignal('');
  const [selectedAudioTrack, setSelectedAudioTrack] = createSignal('');
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = createSignal('');

  // Tab 2: Pre-Flight Byte-Range, Multi-Hash, .omnijrn Journal, Smart Clip Range & Site Rules
  const [probeUrlInput, setProbeUrlInput] = createSignal('https://downloads.example.org/release.bin');
  const [probeResult, setProbeResult] = createSignal<Record<string, unknown> | null>(null);
  const [verifyPath, setVerifyPath] = createSignal('');
  const [verifySha, setVerifySha] = createSignal('');
  const [verifyMd5, setVerifyMd5] = createSignal('');
  const [verifyCrc32c, setVerifyCrc32c] = createSignal('');
  const [verifyResult, setVerifyResult] = createSignal<Record<string, unknown> | null>(null);
  const [journalPath, setJournalPath] = createSignal('');
  const [journalResult, setJournalResult] = createSignal<Record<string, unknown> | null>(null);
  const [clipStartSec, setClipStartSec] = createSignal<string>('0');
  const [clipEndSec, setClipEndSec] = createSignal<string>('45');
  const [seriesSampleName, setSeriesSampleName] = createSignal('Rust Systems Architecture - Ep 06.mp4');
  const [hostRulePattern, setHostRulePattern] = createSignal('*.example.org');
  const [hostRuleCap, setHostRuleCap] = createSignal(8);
  const [hostRulePacing, setHostRulePacing] = createSignal('adaptive');
  const [siteRules, setSiteRules] = createSignal<SiteCapRule[]>([
    { host_pattern: 'arxiv.org', max_connections_per_host: 2, default_pacing: 'polite', note: 'Academic rate guard' },
    { host_pattern: '*.example.org', max_connections_per_host: 8, default_pacing: 'adaptive', note: 'Default mirror cap' },
  ]);

  // Tab 3: MANUAL_VISIBLE_BROWSER_ONLY Handoff Queue & 23-Provider Registry
  const [handoffUrl, setHandoffUrl] = createSignal('https://portal.example.org/protected-file');
  const [handoffReason, setHandoffReason] = createSignal('auth_challenge_required');
  const [handoffDetail, setHandoffDetail] = createSignal('Visible browser verification required');
  const [handoffs, setHandoffs] = createSignal<Array<Record<string, unknown>>>([]);
  const [providerQuery, setProviderQuery] = createSignal('');
  const [providerCategory, setProviderCategory] = createSignal('');
  const [providers, setProviders] = createSignal<Array<Record<string, unknown>>>([]);

  // Tab 4: Deep Protocol Diagnostics (Media Box Tree, Jaccard Schema Drift, RFC 6265 Cookie, Recommender, AIMD/BDP, FFmpeg Mux & CAS Bundles)
  const [mediaMode, setMediaMode] = createSignal<'hex' | 'path'>('hex');
  const [mediaHex, setMediaHex] = createSignal(MEDIA_HEX_PRESETS.pssh);
  const [mediaFilePath, setMediaFilePath] = createSignal('');
  const [mediaTreeResult, setMediaTreeResult] = createSignal<Record<string, unknown> | null>(null);
  const [driftBefore, setDriftBefore] = createSignal('{"id":"asset-1","title":"Archive","size_bytes":1024,"etag":"v1","download_url":"https://downloads.example.org/a.bin"}');
  const [driftAfter, setDriftAfter] = createSignal('{"id":"asset-1","title":"Archive","size_bytes":1024,"etag":"v2","sha256":"abc","crc32c":"def"}');
  const [driftThreshold, setDriftThreshold] = createSignal(0.65);
  const [driftResult, setDriftResult] = createSignal<Record<string, unknown> | null>(null);
  const [cookieUrl, setCookieUrl] = createSignal('https://downloads.example.org/pkg/item.bin');
  const [cookieSameSite, setCookieSameSite] = createSignal<'strict' | 'lax' | 'none'>('lax');
  const [cookieHeaders, setCookieHeaders] = createSignal(
    'fixture_pref=synthetic_compact; Domain=example.org; Path=/; Secure; HttpOnly; SameSite=Lax\nfixture_region=synthetic_us; Domain=downloads.example.org; Path=/pkg; SameSite=Strict\nfixture_bad_psl=synthetic_reject; Domain=.org; Path=/',
  );
  const [cookieResult, setCookieResult] = createSignal<Record<string, unknown> | null>(null);
  const [recSizeMb, setRecSizeMb] = createSignal(250);
  const [recRange, setRecRange] = createSignal(true);
  const [recEtag, setRecEtag] = createSignal(true);
  const [recAuth, setRecAuth] = createSignal(false);
  const [recResult, setRecResult] = createSignal<Record<string, unknown> | null>(null);
  const [aimdStats, setAimdStats] = createSignal<Record<string, unknown> | null>(null);
  const [muxVideo, setMuxVideo] = createSignal('');
  const [muxAudio, setMuxAudio] = createSignal('');
  const [muxOutput, setMuxOutput] = createSignal('D:\\OmniaData\\tmp\\omnia-muxed.mp4');
  const [bundles, setBundles] = createSignal<Array<Record<string, unknown>>>([]);
  const [bundleVerifyResult, setBundleVerifyResult] = createSignal<Record<string, unknown> | null>(null);
  const [inspectorPayload, setInspectorPayload] = createSignal<Record<string, unknown> | null>(null);
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

  const filteredProviders = createMemo(() => {
    const q = providerQuery().trim().toLowerCase();
    const cat = providerCategory().trim().toLowerCase();
    return providers().filter((p) => {
      const pCat = String(p.category ?? '').toLowerCase();
      if (cat && pCat !== cat && !pCat.includes(cat)) return false;
      if (!q) return true;
      const hay = [
        String(p.id ?? ''),
        String(p.name ?? ''),
        pCat,
        Array.isArray(p.host_patterns) ? (p.host_patterns as unknown[]).join(' ') : '',
        Array.isArray(p.domains) ? (p.domains as unknown[]).join(' ') : '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  });

  const seriesPreviewFolder = createMemo(() => {
    if (!autoGroupSeries()) return '(autoGroupSeries OFF)';
    return detectSeriesFolder(seriesSampleName()) ?? '(no episode marker detected -> General)';
  });

  const parsedDrift = createMemo(() => {
    const r = driftResult();
    if (!r) return null;
    const d = (r.drift ?? r.report ?? r) as Record<string, unknown>;
    const pairs = Array.isArray(d.pairs) ? (d.pairs as Array<Record<string, unknown>>) : [];
    const added = Array.isArray(d.added) ? (d.added as unknown[]).map(String) : [];
    const gone = Array.isArray(d.gone) ? (d.gone as unknown[]).map(String) : [];
    return {
      pairs,
      added,
      gone,
      summary: String(d.summary ?? ''),
      driftDetected: Boolean(d.drift_detected ?? d.driftDetected ?? (added.length > 0 || gone.length > 0)),
    };
  });

  const parsedMediaReport = createMemo(() => {
    const r = mediaTreeResult();
    if (!r) return null;
    const rep = (r.report ?? r.media ?? r) as Record<string, unknown>;
    if (!rep || rep.error) return null;
    return {
      format: String(rep.format ?? 'unknown'),
      bytesInspected: Number(rep.bytes_inspected ?? rep.bytesInspected ?? 0),
      majorBrand: rep.major_brand ? String(rep.major_brand) : rep.majorBrand ? String(rep.majorBrand) : '',
      compatibleBrands: Array.isArray(rep.compatible_brands ?? rep.compatibleBrands)
        ? ((rep.compatible_brands ?? rep.compatibleBrands) as unknown[]).map(String)
        : [],
      isFragmented: Boolean(rep.is_fragmented_fmp4 ?? rep.isFragmentedFmp4),
      hasPssh: Boolean(rep.has_pssh ?? rep.hasPssh),
      drmDetected: Boolean(rep.drm_detected ?? rep.drmDetected),
      isoBoxes: Array.isArray(rep.iso_boxes ?? rep.isoBoxes)
        ? ((rep.iso_boxes ?? rep.isoBoxes) as Array<Record<string, unknown>>)
        : [],
      drmBoxes: Array.isArray(rep.drm_boxes ?? rep.drmBoxes)
        ? ((rep.drm_boxes ?? rep.drmBoxes) as Array<Record<string, unknown>>)
        : [],
      mpegTs: (rep.mpeg_ts ?? rep.mpegTs) as Record<string, unknown> | null | undefined,
      adts: rep.adts as Record<string, unknown> | null | undefined,
    };
  });

  const parsedProbe = createMemo(() => {
    const r = probeResult();
    if (!r || r.error) return null;
    const p = (r.probe ?? r) as Record<string, unknown>;
    return {
      status: p.status ?? p.http_status ?? p.httpStatus ?? null,
      supportsRange: Boolean(p.accept_ranges ?? p.supports_ranges ?? p.supportsRange ?? p.range_supported),
      contentLength: Number(p.content_length ?? p.contentLength ?? p.total_bytes ?? 0),
      etag: String(p.etag ?? ''),
      validatorStrength: String(p.validator_strength ?? p.validatorStrength ?? ''),
      crc32c: String(p.crc32c_b64 ?? p.crc32c ?? p.x_goog_hash ?? ''),
      filename: String(p.filename ?? p.suggested_filename ?? ''),
    };
  });

  const parsedAimd = createMemo(() => {
    const a = aimdStats();
    if (!a || a.error) return null;
    const m = (a.metrics ?? a.aimd ?? a) as Record<string, unknown>;
    return {
      currentWindow: Number(m.current_window ?? m.currentWindow ?? 0),
      maxWindow: Number(m.max_window ?? m.maxWindow ?? 16),
      ssthresh: Number(m.ssthresh ?? 0),
      rttMs: Number(m.smoothed_rtt_ms ?? m.smoothedRttMs ?? 0),
      bwBps: Number(m.estimated_bandwidth_bps ?? m.estimatedBandwidthBps ?? 0),
      bdpBytes: Number(m.bdp_bytes ?? m.bdpBytes ?? 0),
      backoffs: Number(m.backoff_events ?? m.backoffEvents ?? 0),
    };
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
    const [res, aRes] = await Promise.all([api.listDownloads(), api.getDriveAimdStats()]);
    if (res.ok && Array.isArray(res.data.jobs)) {
      setJobs(res.data.jobs);
      const totalBps = res.data.jobs.reduce((acc, j) => acc + Number(j.speed_bps ?? j.speedBps ?? 0), 0);
      setSpeedSamples((prev) => [...prev.slice(-47), totalBps]);
    }
    if (aRes.ok) {
      setAimdStats(aRes.data);
    }
  };

  const loadHandoffsAndProviders = async () => {
    const [hRes, pRes] = await Promise.all([
      api.listDriveHandoffs(),
      api.listDriveProviders(providerQuery(), providerCategory()),
    ]);
    if (hRes.ok) {
      const list = (hRes.data.tickets ?? hRes.data.handoffs ?? hRes.data.items ?? []) as Array<Record<string, unknown>>;
      setHandoffs(Array.isArray(list) ? list : []);
    }
    if (pRes.ok) {
      const list = (pRes.data.providers ?? pRes.data.items ?? []) as Array<Record<string, unknown>>;
      setProviders(Array.isArray(list) ? list : []);
    }
  };

  const loadAimdAndScheduler = async () => {
    const [aRes, sRes] = await Promise.all([api.getDriveAimdStats(), api.getDriveScheduler()]);
    if (aRes.ok) setAimdStats(aRes.data);
    if (sRes.ok) {
      setSchedulerState(sRes.data);
      const cfg = (sRes.data.config ?? sRes.data) as Record<string, unknown>;
      if (typeof cfg.max_concurrent_jobs === 'number') setSchedulerMaxConcurrent(cfg.max_concurrent_jobs);
      else if (typeof cfg.maxConcurrentJobs === 'number') setSchedulerMaxConcurrent(cfg.maxConcurrentJobs);
      const rules = (sRes.data.siteRules ?? sRes.data.site_rules) as SiteCapRule[] | undefined;
      if (Array.isArray(rules) && rules.length > 0) setSiteRules(rules);
    }
  };

  const loadBundles = async () => {
    const res = await api.safeJson<Record<string, unknown>>('/api/omni-drive/bundles');
    if (res.ok) {
      const list = (res.data.bundles ?? res.data.items ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(list)) setBundles(list);
    }
  };

  createEffect(() => {
    speedSamples();
    themePref();
    studioTab();
    drawWaveOnce();
  });

  onMount(() => {
    void refreshJobs();
    void loadAimdAndScheduler();
    void loadHandoffsAndProviders();
    const timer = setInterval(() => void refreshJobs(), 2500);
    onCleanup(() => clearInterval(timer));
  });

  const switchStudioTab = (next: DriveStudioTab) => {
    setStudioTab(next);
    if (next === 'integrity') void loadAimdAndScheduler();
    if (next === 'handoff') void loadHandoffsAndProviders();
    if (next === 'protocol') {
      void loadAimdAndScheduler();
      void loadBundles();
    }
  };

  const handleProbeManifestTracks = async () => {
    const target = url().trim();
    if (!target) {
      setStatusMsg('Paste an HLS (.m3u8), DASH (.mpd), or HTTP URL first');
      return;
    }
    setManifestProbeBusy(true);
    let r = await api.safeJson<Record<string, unknown>>('/api/downloads/probe', {
      method: 'POST',
      body: JSON.stringify({ url: target }),
    });
    if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
      r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/probe', {
        method: 'POST',
        body: JSON.stringify({ url: target }),
      });
    }
    setManifestProbeBusy(false);
    if (!r.ok) {
      setInspectorPayload({ error: r.error.code, message: r.error.message });
      setStatusMsg(`Track probe (${r.error.code}): ${r.error.message}`);
      return;
    }
    setInspectorPayload(r.data);
    const root = (r.data.probe ?? r.data.manifest ?? r.data) as Record<string, unknown>;
    const rawVideo = (root.video_tracks ?? root.videoTracks ?? root.variants ?? root.representations ?? []) as Array<
      Record<string, unknown>
    >;
    const rawAudio = (root.audio_tracks ?? root.audioTracks ?? root.audio_renditions ?? []) as Array<
      Record<string, unknown>
    >;
    const rawSubs = (root.subtitle_tracks ?? root.subtitleTracks ?? root.subtitles ?? []) as Array<
      Record<string, unknown>
    >;
    const toTrack = (item: Record<string, unknown>, idx: number, fallbackPrefix: string) => {
      const tUrl = String(item.url ?? item.uri ?? item.stream_url ?? target);
      const res = item.resolution ? String(item.resolution) : item.height ? `${item.height}p` : '';
      const bw = item.bandwidth ? `${Math.round(Number(item.bandwidth) / 1000)} kbps` : '';
      const codec = item.codecs ?? item.codec ? String(item.codecs ?? item.codec) : '';
      const lang = item.language ?? item.lang ? String(item.language ?? item.lang) : '';
      const parts = [String(item.label ?? item.name ?? `${fallbackPrefix} #${idx + 1}`), res, bw, lang, codec].filter(
        Boolean,
      );
      return {
        id: String(item.id ?? `${fallbackPrefix.toLowerCase()}-${idx}`),
        label: parts.join(' · '),
        url: tUrl,
      };
    };
    const video = Array.isArray(rawVideo) ? rawVideo.map((v, i) => toTrack(v, i, 'Video')) : [];
    const audio = Array.isArray(rawAudio) ? rawAudio.map((a, i) => toTrack(a, i, 'Audio')) : [];
    const subtitles = Array.isArray(rawSubs) ? rawSubs.map((s, i) => toTrack(s, i, 'Subtitle')) : [];
    const lower = target.toLowerCase();
    const kind = lower.includes('.m3u8') ? 'HLS (.m3u8)' : lower.includes('.mpd') ? 'DASH (.mpd)' : 'HTTP Media';
    setManifestTracks({
      kind,
      sourceUrl: target,
      video: video.length > 0 ? video : [{ id: 'auto-best', label: 'Auto Best Video (Engine Select)', url: target }],
      audio: audio.length > 0 ? audio : [{ id: 'auto-audio', label: 'Default Audio Track', url: '' }],
      subtitles,
    });
    setSelectedVideoTrack(video[0]?.url ?? target);
    setSelectedAudioTrack(audio[0]?.url ?? '');
    setSelectedSubtitleTrack(subtitles[0]?.url ?? '');
    setStatusMsg(`Probed ${kind}: ${video.length} video, ${audio.length} audio, ${subtitles.length} sub track(s)`);
  };

  const handleFfprobeTarget = async () => {
    const target = url().trim() || muxVideo().trim();
    if (!target) {
      setStatusMsg('Enter a local media file path (or HTTP URL for remote probe)');
      return;
    }
    if (/^https?:\/\//i.test(target)) {
      setProbeUrlInput(target);
      let r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/probe', {
        method: 'POST',
        body: JSON.stringify({ url: target }),
      });
      if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
        r = await api.probeDriveUrl(target);
      }
      setInspectorPayload({
        mode: 'remote_http_probe_fallback',
        diagnostic:
          'FFprobe requires a local filesystem path (not an http(s):// URL). Executed Pre-Flight HTTP 206 Remote Probe instead.',
        target,
        probe: r.ok ? r.data : { error: r.error.code, message: r.error.message },
      });
      setStatusMsg(
        r.ok
          ? 'FFprobe requires a local path — ran HTTP 206 Remote Probe instead'
          : `FFprobe requires local path; remote probe failed (${r.error.code})`,
      );
      return;
    }
    let r = await api.safeJson<Record<string, unknown>>('/api/downloads/media/ffprobe', {
      method: 'POST',
      body: JSON.stringify({ path: target, mediaPath: target, target }),
    });
    if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
      r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/media/ffprobe', {
        method: 'POST',
        body: JSON.stringify({ path: target, mediaPath: target, target }),
      });
    }
    setInspectorPayload(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'FFprobe inspected local media file' : `FFprobe (${r.error.code}): ${r.error.message}`);
  };

  const handleStart = async () => {
    const targetUrl = selectedVideoTrack().trim() || url().trim();
    if (!targetUrl) return;
    const extraAudio = selectedAudioTrack().trim();
    const extraSub = selectedSubtitleTrack().trim();
    const res =
      extraAudio || extraSub
        ? await api.safeJson<Record<string, unknown>>('/api/downloads/start', {
            method: 'POST',
            body: JSON.stringify({
              url: targetUrl,
              streams: streams(),
              pacing_mode: pacing(),
              pacingMode: pacing(),
              audio_track_url: extraAudio || undefined,
              audioTrackUrl: extraAudio || undefined,
              subtitle_track_url: extraSub || undefined,
              subtitleTrackUrl: extraSub || undefined,
            }),
          })
        : await api.startDownload(targetUrl, streams(), pacing());
    if (res.ok) {
      setStatusMsg(`Queued job ${String(res.data.job_id ?? '')}`);
      setUrl('');
      setManifestTracks(null);
      setSelectedVideoTrack('');
      setSelectedAudioTrack('');
      setSelectedSubtitleTrack('');
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

  const handlePlanBatch = async () => {
    const raw = batchInput().trim();
    if (!raw) return;
    const localPlan = extractLocalBatchPlan(raw, autoGroupSeries(), categorizeSubfolders());
    const planRes = await api.safeJson<Record<string, unknown>>('/api/omni-drive/batch/plan', {
      method: 'POST',
      body: JSON.stringify({
        input: raw,
        text: raw,
        autoGroupSeries: autoGroupSeries(),
        auto_group_series: autoGroupSeries(),
        categorizeSubfolders: categorizeSubfolders(),
        categorize_subfolders: categorizeSubfolders(),
        maxConnsPerHost: hostRuleCap(),
      }),
    });
    if (planRes.ok) {
      setBatchResult(planRes.data);
      const srvItems = (planRes.data.items ?? planRes.data.planned ?? []) as Array<Record<string, unknown>>;
      if (Array.isArray(srvItems) && srvItems.length > 0) {
        const mapped: PlannedBatchItem[] = srvItems.map((it) => {
          const u = String(it.canonicalUrl ?? it.canonical_url ?? it.url ?? '');
          const fname = String(it.filename ?? u.split('?')[0].split('/').pop() ?? 'item.bin');
          return {
            url: String(it.url ?? u),
            canonicalUrl: u,
            provider: String(it.provider ?? inferProviderName(u)),
            category: String(it.category ?? classifyExtCategory(fname)),
            folder: String(it.folder ?? it.destination_dir ?? classifyExtCategory(fname)),
            filename: fname,
            deduped: Boolean(it.deduped),
          };
        });
        setBatchItems(mapped);
        const kpi = (planRes.data.kpi ?? planRes.data.summary ?? planRes.data) as Record<string, unknown>;
        setBatchKpi({
          extracted: Number(kpi.extracted ?? kpi.totalExtracted ?? localPlan.extracted),
          unique: Number(kpi.unique ?? mapped.length),
          deduped: Number(kpi.deduped ?? kpi.duplicatesRemoved ?? Math.max(0, localPlan.extracted - mapped.length)),
          folders: Number(kpi.folders ?? new Set(mapped.map((m) => m.folder)).size),
        });
      } else {
        setBatchItems(localPlan.items);
        setBatchKpi({
          extracted: localPlan.extracted,
          unique: localPlan.unique,
          deduped: localPlan.deduped,
          folders: localPlan.folders,
        });
      }
      setStatusMsg(`Planned ${batchKpi().unique} unique URL(s), stripped ${batchKpi().deduped} dup(s)`);
      return;
    }

    // Fallback: backend `/api/omni-drive/batch-expand` + deterministic local deduper
    const firstPattern = raw.split(/\r?\n/).find((l) => /\[[^\]]+-[^\]]+\]/.test(l))?.trim();
    const expRes = firstPattern
      ? await api.safeJson<Record<string, unknown>>('/api/omni-drive/batch-expand', {
          method: 'POST',
          body: JSON.stringify({ pattern: firstPattern }),
        })
      : null;
    setBatchItems(localPlan.items);
    setBatchKpi({
      extracted: localPlan.extracted,
      unique: localPlan.unique,
      deduped: localPlan.deduped,
      folders: localPlan.folders,
    });
    setBatchResult(
      expRes && expRes.ok
        ? { ...expRes.data, kpi: { extracted: localPlan.extracted, unique: localPlan.unique, deduped: localPlan.deduped, folders: localPlan.folders } }
        : {
            ok: true,
            mode: 'client_dedupe_plan',
            kpi: { extracted: localPlan.extracted, unique: localPlan.unique, deduped: localPlan.deduped, folders: localPlan.folders },
            items: localPlan.items,
          },
    );
    setStatusMsg(`Planned ${localPlan.unique} unique / ${localPlan.deduped} deduped across ${localPlan.folders} folder(s)`);
  };

  const handleBatchEnqueue = async () => {
    const items = batchItems();
    if (items.length === 0) {
      setStatusMsg('Plan a batch first before enqueueing');
      return;
    }
    const r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/batch/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        urls: items.map((i) => i.canonicalUrl),
        items,
        streams: streams(),
        pacing_mode: pacing(),
        autoGroupSeries: autoGroupSeries(),
        maxConnsPerHost: hostRuleCap(),
      }),
    });
    if (r.ok) {
      setBatchResult(r.data);
      setStatusMsg(`Batch enqueued ${items.length} item(s)`);
      await refreshJobs();
      return;
    }
    let queued = 0;
    for (const item of items) {
      const startRes = await api.startDownload(item.canonicalUrl, streams(), pacing());
      if (startRes.ok) queued += 1;
    }
    setStatusMsg(`Enqueued ${queued}/${items.length} batch item(s) via /api/downloads/start`);
    await refreshJobs();
  };

  const handleSaveScheduler = async () => {
    const r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/scheduler', {
      method: 'POST',
      body: JSON.stringify({
        max_concurrent_jobs: schedulerMaxConcurrent(),
        maxConcurrentJobs: schedulerMaxConcurrent(),
        window: {
          start_hour_utc: schedulerStartUtc(),
          end_hour_utc: schedulerEndUtc(),
        },
        site_rules: siteRules(),
        siteRules: siteRules(),
      }),
    });
    setSchedulerState(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'Updated OmniDrive scheduler & site caps' : `Scheduler (${r.error.code})`);
  };

  const handleProbe = async () => {
    const target = probeUrlInput().trim();
    if (!target) return;
    let r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/probe', {
      method: 'POST',
      body: JSON.stringify({ url: target }),
    });
    if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
      r = await api.probeDriveUrl(target);
    }
    setProbeResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'Pre-flight HTTP 206 probe complete' : `Probe (${r.error.code})`);
  };

  const handleVerifyIntegrity = async () => {
    if (!verifyPath().trim()) return;
    const r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/integrity/verify', {
      method: 'POST',
      body: JSON.stringify({
        path: verifyPath().trim(),
        expectedSha256: verifySha().trim() || undefined,
        expected_sha256: verifySha().trim() || undefined,
        expectedMd5: verifyMd5().trim() || undefined,
        expected_md5: verifyMd5().trim() || undefined,
        expectedCrc32c: verifyCrc32c().trim() || undefined,
        expected_crc32c_b64: verifyCrc32c().trim() || undefined,
      }),
    });
    setVerifyResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'Multi-hash integrity check complete' : `Verify (${r.error.code})`);
  };

  const handleInspectMedia = async () => {
    const body =
      mediaMode() === 'path'
        ? { path: mediaFilePath().trim() }
        : { hex: mediaHex().trim() };
    let r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/media/inspect', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
      r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/inspect-media', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    setMediaTreeResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'Parsed binary media container tree (read-only DRM)' : `MediaBox (${r.error.code})`);
  };

  const handleDriftCompare = async () => {
    let r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/drift/compare', {
      method: 'POST',
      body: JSON.stringify({ before: driftBefore(), after: driftAfter(), threshold: driftThreshold() }),
    });
    if (!r.ok && (r.error.status === 404 || r.error.status === 405)) {
      r = await api.safeJson<Record<string, unknown>>('/api/downloads/schema-drift', {
        method: 'POST',
        body: JSON.stringify({ before: driftBefore(), after: driftAfter(), threshold: driftThreshold() }),
      });
    }
    setDriftResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
    setStatusMsg(r.ok ? 'Computed 3-gram Jaccard schema drift' : `Drift (${r.error.code})`);
  };

  const handleSealBundle = async () => {
    const sourceUrl = url().trim() || probeUrlInput().trim() || 'https://downloads.example.org/release.bin';
    const parts = [
      { name: 'manifest.txt', text: `OmniDrive sealed capture bundle at ${new Date().toISOString()}` },
    ];
    let res = await api.safeJson<Record<string, unknown>>('/api/omni-drive/bundles/capture', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, parts }),
    });
    if (!res.ok && (res.error.status === 404 || res.error.status === 405)) {
      res = await api.sealCaptureBundle(sourceUrl, parts);
    }
    if (res.ok) {
      setInspectorPayload(res.data);
      const b = (res.data.bundle ?? res.data) as Record<string, unknown>;
      setBundles((prev) => [b, ...prev.slice(0, 19)]);
      setStatusMsg('Sealed SHA-256 CAS CaptureBundle');
    } else {
      setStatusMsg(`Bundle error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleVerifyBundle = async (bundle: Record<string, unknown>) => {
    const res = await api.safeJson<Record<string, unknown>>('/api/downloads/capture-bundles/verify', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    });
    setBundleVerifyResult(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setStatusMsg(res.ok ? `Bundle verified: ${String(res.data.verified ?? true)}` : `Verify (${res.error.code})`);
  };

  const handleMux = async () => {
    if (!muxVideo().trim()) {
      setStatusMsg('Enter a video stream path for FFmpeg mux/clip');
      return;
    }
    const startSec = Number.parseFloat(clipStartSec());
    const endSec = Number.parseFloat(clipEndSec());
    const hasClip = Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec;
    const res = await api.safeJson<Record<string, unknown>>('/api/downloads/media/mux', {
      method: 'POST',
      body: JSON.stringify({
        videoInput: muxVideo().trim(),
        video: muxVideo().trim(),
        audioInput: muxAudio().trim() || undefined,
        audio: muxAudio().trim() || undefined,
        outputPath: muxOutput().trim() || 'D:\\OmniaData\\tmp\\omnia-muxed.mp4',
        output: muxOutput().trim() || 'D:\\OmniaData\\tmp\\omnia-muxed.mp4',
        clipInSecs: hasClip ? startSec : undefined,
        clipOutSecs: hasClip ? endSec : undefined,
        clipStartSec: hasClip ? startSec : undefined,
        clipEndSec: hasClip ? endSec : undefined,
      }),
    });
    if (res.ok) {
      setInspectorPayload(res.data);
      setStatusMsg(hasClip ? `FFmpeg clip/mux (${startSec}s..${endSec}s) completed` : 'FFmpeg mux completed');
    } else {
      setInspectorPayload({ error: res.error.code, message: res.error.message });
      setStatusMsg(`FFmpeg mux (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="omnidrive-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Studio Sub-Tab Bar */}
      <div class="px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <Download class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
          <span class="font-bold text-[13.5px]">OmniDrive v3.0 Protocol Studio</span>
          <span class="omnia-badge text-[var(--status-emerald)] font-mono-num text-[10.5px]">
            <Database class="w-3 h-3" />
            <span>SQLite WAL</span>
          </span>
          <span class="omnia-badge text-[var(--ink-secondary)] font-mono-num text-[10.5px]">
            {providers().length || 23} Providers
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <div data-testid="omnidrive-tabs" class="omp-segmented flex-wrap text-[11.5px]">
            <button type="button" aria-pressed={studioTab() === 'transfers'} onClick={() => switchStudioTab('transfers')}>
              1. Batch Planner & .EF2
            </button>
            <button type="button" aria-pressed={studioTab() === 'integrity'} onClick={() => switchStudioTab('integrity')}>
              2. Probe · Hash · .omnijrn
            </button>
            <button type="button" aria-pressed={studioTab() === 'handoff'} onClick={() => switchStudioTab('handoff')}>
              3. Handoff Queue & Providers
            </button>
            <button type="button" aria-pressed={studioTab() === 'protocol'} onClick={() => switchStudioTab('protocol')}>
              4. Protocol Diagnostics
            </button>
          </div>
          <Show when={statusMsg()}>
            <span class="text-[11px] font-mono-num text-[var(--accent-amber)] truncate max-w-[320px]">
              {statusMsg()}
            </span>
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {/* TAB 1: Transfers, Bezier Wave, 128-Chunk Bitmap, Batch Link Planner, .EF2 & Scheduler */}
        <Show when={studioTab() === 'transfers'}>
          {/* Single Transfer Launcher */}
          <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="https://downloads.example.org/archive.bin (HTTP, Google Drive, Moodle, HLS .m3u8, DASH .mpd)"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                class="flex-1 min-w-[200px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[12px] font-mono-num outline-none"
              />
              <select
                value={streams()}
                onChange={(e) => setStreams(Number(e.currentTarget.value))}
                class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
              >
                {[1, 4, 8, 12, 16, 32].map((n) => (
                  <option value={n}>{n} streams</option>
                ))}
              </select>
              <select
                value={pacing()}
                onChange={(e) => setPacing(e.currentTarget.value)}
                class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px]"
              >
                <option value="adaptive">Adaptive (AIMD+BDP)</option>
                <option value="turbo">Turbo (Multi-Stream)</option>
                <option value="polite">Polite (1 Stream)</option>
                <option value="linear_rate_guarded">Linear Rate Guarded</option>
              </select>
              <button type="button" class="omnia-btn omnia-btn-primary text-[12px]" onClick={() => void handleStart()}>
                <Play class="w-3.5 h-3.5" />
                <span>Start Transfer</span>
              </button>
              <button
                type="button"
                data-testid="omnidrive-probe-tracks-btn"
                disabled={manifestProbeBusy()}
                class="omnia-btn text-[12px]"
                title="Discover HLS (.m3u8) / DASH (.mpd) video, audio & subtitle tracks before downloading"
                onClick={() => void handleProbeManifestTracks()}
              >
                <Layers class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                <span>{manifestProbeBusy() ? 'Probing...' : 'HLS/DASH Tracks'}</span>
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
                  setInspectorPayload(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                  setStatusMsg(r.ok ? `Crawl (${crawlKind()}) finished` : `Crawl (${r.error.code})`);
                }}
              >
                <Search class="w-3.5 h-3.5" />
                <span>Crawl</span>
              </button>
              <button
                type="button"
                data-testid="omnidrive-ffprobe-btn"
                class="omnia-btn text-[12px]"
                title="FFprobe local file path (automatically switches to HTTP 206 Remote Probe for http(s):// URLs)"
                onClick={() => void handleFfprobeTarget()}
              >
                <Film class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                <span>FFprobe</span>
              </button>
              <button type="button" class="omnia-btn text-[12px]" title="Refresh queue" onClick={() => void refreshJobs()}>
                <RefreshCw class="w-3.5 h-3.5" />
              </button>
            </div>

            {/* HLS / DASH Track Selector (when probed) */}
            <Show when={manifestTracks()}>
              {(mt) => (
                <div
                  data-testid="omnidrive-hls-dash-selector"
                  class="p-2.5 rounded border border-[var(--border-accent)] bg-[var(--bg-canvas)] space-y-2 text-[11.5px]"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="font-semibold text-[var(--accent-cyan)] flex items-center gap-1.5">
                      <Layers class="w-3.5 h-3.5" />
                      <span>{mt().kind} Track Selector (DRM Bypass: Disabled)</span>
                    </span>
                    <button
                      type="button"
                      class="omnia-btn px-2 py-0.5 text-[10.5px]"
                      onClick={() => {
                        setManifestTracks(null);
                        setSelectedVideoTrack('');
                        setSelectedAudioTrack('');
                        setSelectedSubtitleTrack('');
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <label class="space-y-1">
                      <span class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">Video Variant</span>
                      <select
                        value={selectedVideoTrack()}
                        onChange={(e) => setSelectedVideoTrack(e.currentTarget.value)}
                        class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 text-[11.5px]"
                      >
                        <For each={mt().video}>{(v) => <option value={v.url}>{v.label}</option>}</For>
                      </select>
                    </label>
                    <label class="space-y-1">
                      <span class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">Audio Track</span>
                      <select
                        value={selectedAudioTrack()}
                        onChange={(e) => setSelectedAudioTrack(e.currentTarget.value)}
                        class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 text-[11.5px]"
                      >
                        <For each={mt().audio}>{(a) => <option value={a.url}>{a.label}</option>}</For>
                      </select>
                    </label>
                    <label class="space-y-1">
                      <span class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">Subtitles</span>
                      <select
                        value={selectedSubtitleTrack()}
                        onChange={(e) => setSelectedSubtitleTrack(e.currentTarget.value)}
                        class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 text-[11.5px]"
                      >
                        <option value="">None ({mt().subtitles.length} available)</option>
                        <For each={mt().subtitles}>{(s) => <option value={s.url}>{s.label}</option>}</For>
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </Show>
          </div>

          {/* Live Telemetry: Bezier Throughput Wave + Live AIMD/BDP + 128-Chunk Heatmap & Per-Stream Bars */}
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5 min-w-0">
              <div class="flex items-center justify-between text-[12px]">
                <span class="font-semibold flex items-center gap-1.5">
                  <Activity class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                  <span>Bezier Throughput Wave &amp; Live AIMD/BDP</span>
                </span>
                <span class="font-mono-num text-[var(--ink-muted)]">
                  {(speedSamples()[speedSamples().length - 1] / 1024).toFixed(1)} KiB/s
                </span>
              </div>
              <canvas ref={waveCanvasRef} class="w-full h-28 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]" />
              <div
                data-testid="omnidrive-tab1-aimd-strip"
                class="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-[10px] font-mono-num"
              >
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">cwnd</div>
                  <div class="font-bold text-[var(--accent-cyan)]">
                    {parsedAimd()?.currentWindow ?? 0}/{parsedAimd()?.maxWindow ?? 16}
                  </div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">ssthresh</div>
                  <div class="font-bold">{parsedAimd()?.ssthresh ?? 0}</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">RTT</div>
                  <div class="font-bold">{(parsedAimd()?.rttMs ?? 0).toFixed(1)}ms</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">Est BW</div>
                  <div class="font-bold">{formatBytes(parsedAimd()?.bwBps ?? 0)}/s</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">BDP</div>
                  <div class="font-bold">{formatBytes(parsedAimd()?.bdpBytes ?? 0)}</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9px] text-[var(--ink-muted)]">Backoffs</div>
                  <div class="font-bold text-[var(--accent-amber)]">{parsedAimd()?.backoffs ?? 0}</div>
                </div>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
              <div class="flex items-center justify-between text-[12px] gap-2">
                <span class="font-semibold">128-Chunk Bitmap &amp; Per-Stream Bars</span>
                <span class="font-mono-num text-[var(--ink-muted)] truncate max-w-[220px]">
                  {selectedJob()
                    ? `${String(selectedJob()!.filename || selectedJob()!.id)} (${cellFractions().filter((f) => f > 0.9).length}/128)`
                    : 'No active transfer (0/128)'}
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

          {/* Batch Link Planner & Deduplicator (KPI Strip + Table + .EF2 + Scheduler) + Active Queue */}
          <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-4">
            <div class="omnia-surface-panel rounded-lg p-3.5 space-y-3 text-[12px] min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-semibold flex items-center gap-1.5">
                  <Layers class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>Batch Link Planner & Deduplicator (Markdown · HTML · Patterns · .EF2)</span>
                </span>
                <div class="flex flex-wrap items-center gap-2 text-[11px]">
                  <label class="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoGroupSeries()}
                      onChange={(e) => setAutoGroupSeries(e.currentTarget.checked)}
                    />
                    <span>autoGroupSeries</span>
                  </label>
                  <label class="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={categorizeSubfolders()}
                      onChange={(e) => setCategorizeSubfolders(e.currentTarget.checked)}
                    />
                    <span>5-Category Folders</span>
                  </label>
                </div>
              </div>

              {/* KPI Strip */}
              <div data-testid="omnidrive-batch-kpi" class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--ink-muted)]">Extracted</div>
                  <div class="text-[16px] font-bold font-mono-num text-[var(--ink-primary)]">{batchKpi().extracted}</div>
                </div>
                <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--ink-muted)]">Unique</div>
                  <div class="text-[16px] font-bold font-mono-num text-[var(--status-emerald)]">{batchKpi().unique}</div>
                </div>
                <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--ink-muted)]">Deduped</div>
                  <div class="text-[16px] font-bold font-mono-num text-[var(--accent-amber)]">{batchKpi().deduped}</div>
                </div>
                <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--ink-muted)]">Folders</div>
                  <div class="text-[16px] font-bold font-mono-num text-[var(--accent-cyan)]">{batchKpi().folders}</div>
                </div>
              </div>

              <textarea
                rows={3}
                value={batchInput()}
                onInput={(e) => setBatchInput(e.currentTarget.value)}
                placeholder="Paste mixed Markdown [text](url), HTML <a href=...>, plain URLs with utm_*/fbclid, or ranges [01-10]..."
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 text-[11.5px] font-mono-num"
              />

              <div class="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid="omnidrive-batch-expand-btn"
                  class="omnia-btn omnia-btn-primary text-[11px]"
                  onClick={() => void handlePlanBatch()}
                >
                  <Sparkles class="w-3.5 h-3.5" />
                  <span>Plan & Dedupe Batch</span>
                </button>
                <button
                  type="button"
                  data-testid="omnidrive-batch-enqueue-btn"
                  class="omnia-btn text-[11px]"
                  disabled={batchItems().length === 0}
                  onClick={() => void handleBatchEnqueue()}
                >
                  <Play class="w-3 h-3 text-[var(--status-emerald)]" />
                  <span>Batch Enqueue ({batchItems().length})</span>
                </button>
                <button
                  type="button"
                  class="omnia-btn text-[11px]"
                  onClick={async () => {
                    const urls =
                      batchItems().length > 0
                        ? batchItems().map((i) => i.canonicalUrl)
                        : batchInput().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                    const r = await api.exportDriveEf2(urls);
                    const content = r.ok
                      ? String(r.data.ef2 ?? r.data.content ?? formatEf2Local(urls))
                      : formatEf2Local(urls);
                    setEf2Text(content);
                    downloadTextFile('omnidrive-batch.ef2', content, 'text/plain;charset=utf-8');
                    setStatusMsg(r.ok ? 'Exported .EF2 via backend' : 'Exported .EF2 locally');
                  }}
                >
                  Export .EF2
                </button>
                <button
                  type="button"
                  class="omnia-btn text-[11px]"
                  onClick={async () => {
                    const payload = ef2Text().trim() || batchInput().trim();
                    const r = await api.importDriveEf2(payload);
                    setBatchResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                    if (r.ok && Array.isArray(r.data.entries)) {
                      const urls = (r.data.entries as Array<Record<string, unknown>>).map((e) => String(e.url ?? '')).filter(Boolean);
                      if (urls.length > 0) {
                        setBatchInput(urls.join('\n'));
                        const lp = extractLocalBatchPlan(urls.join('\n'), autoGroupSeries(), categorizeSubfolders());
                        setBatchItems(lp.items);
                        setBatchKpi({ extracted: lp.extracted, unique: lp.unique, deduped: lp.deduped, folders: lp.folders });
                      }
                    }
                    setStatusMsg(r.ok ? 'Imported .EF2 manifest' : `EF2 import (${r.error.code})`);
                  }}
                >
                  Import .EF2
                </button>
              </div>

              <Show when={batchItems().length > 0}>
                <div class="max-h-44 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <table class="w-full text-left border-collapse text-[11px] font-mono-num">
                    <thead class="bg-[var(--bg-elevated)] text-[var(--ink-muted)]">
                      <tr>
                        <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Provider</th>
                        <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Folder</th>
                        <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Canonical URL (tracking stripped)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={batchItems()}>
                        {(item) => (
                          <tr class="border-b border-[var(--border-subtle)] last:border-b-0">
                            <td class="px-2 py-1 text-[var(--accent-cyan)] whitespace-nowrap">{item.provider}</td>
                            <td class="px-2 py-1 text-[var(--accent-amber)] whitespace-nowrap">{item.folder}</td>
                            <td class="px-2 py-1 text-[var(--ink-secondary)] break-all">
                              {maskText(item.canonicalUrl, privacyMask())}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>

              {/* Scheduler Controls */}
              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-semibold text-[11.5px] flex items-center gap-1.5">
                    <Clock class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                    <span>Download Scheduler & Concurrency Window (UTC)</span>
                  </span>
                  <div class="flex gap-1.5">
                    <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void loadAimdAndScheduler()}>
                      Sync
                    </button>
                    <button type="button" class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]" onClick={() => void handleSaveScheduler()}>
                      Save Schedule
                    </button>
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-[11px]">
                  <label class="flex items-center gap-1">
                    <span class="text-[var(--ink-muted)]">Max Concurrent:</span>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={schedulerMaxConcurrent()}
                      onInput={(e) => setSchedulerMaxConcurrent(Number(e.currentTarget.value))}
                      class="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-mono-num"
                    />
                  </label>
                  <label class="flex items-center gap-1">
                    <span class="text-[var(--ink-muted)]">UTC Start:</span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={schedulerStartUtc()}
                      onInput={(e) => setSchedulerStartUtc(Number(e.currentTarget.value))}
                      class="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-mono-num"
                    />
                  </label>
                  <label class="flex items-center gap-1">
                    <span class="text-[var(--ink-muted)]">UTC End:</span>
                    <input
                      type="number"
                      min={0}
                      max={24}
                      value={schedulerEndUtc()}
                      onInput={(e) => setSchedulerEndUtc(Number(e.currentTarget.value))}
                      class="w-14 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-mono-num"
                    />
                  </label>
                </div>
                <Show when={schedulerState() || batchResult()}>
                  <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-28 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(maskJson(schedulerState() ?? batchResult(), privacyMask()), null, 2)}
                  </pre>
                </Show>
              </div>
            </div>

            {/* Active Download Queue */}
            <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <span class="font-semibold text-[12.5px]">Download Queue ({jobs().length})</span>
                <Show when={inspectorPayload()}>
                  <button
                    type="button"
                    class="omnia-btn px-2 py-0.5 text-[10.5px]"
                    onClick={() => setInspectorPayload(null)}
                  >
                    Clear Receipt
                  </button>
                </Show>
              </div>
              <Show
                when={jobs().length > 0}
                fallback={
                  <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                    No queued transfers yet. Paste a URL above or plan a batch on the left.
                  </div>
                }
              >
                <div class="space-y-2 max-h-64 overflow-y-auto">
                  <For each={jobs()}>
                    {(job) => {
                      const jid = String(job.id ?? job.job_id);
                      const sha = String(job.sha256_actual ?? job.sha256 ?? '');
                      return (
                        <div
                          onClick={() => setSelectedJobId(jid)}
                          class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 cursor-pointer"
                        >
                          <div class="min-w-0 space-y-0.5">
                            <div class="text-[12px] font-semibold truncate">
                              {maskText(String(job.filename || job.url || jid), privacyMask())}
                            </div>
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
                </div>
              </Show>

              <Show when={inspectorPayload()}>
                <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1">
                  <div class="text-[11px] font-semibold text-[var(--ink-muted)]">Latest Crawl / FFprobe / Mux Receipt</div>
                  <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(maskJson(inspectorPayload(), privacyMask()), null, 2)}
                  </pre>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        {/* TAB 2: Pre-Flight Byte-Range, Multi-Hash, .omnijrn Journal, Smart Clip Range & Per-Host Cap */}
        <Show when={studioTab() === 'integrity'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 text-[12px]">
            <div class="space-y-4 min-w-0">
              {/* Pre-Flight Byte-Range Probe */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
                <div class="font-bold text-[13px] flex items-center gap-2">
                  <Globe class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Pre-Flight Byte-Range Probe (HTTP 206 · ETag · x-goog-hash)</span>
                </div>
                <div class="flex gap-2">
                  <input
                    type="text"
                    value={probeUrlInput()}
                    onInput={(e) => setProbeUrlInput(e.currentTarget.value)}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11.5px]"
                  />
                  <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleProbe()}>
                    Probe 206
                  </button>
                </div>

                <Show when={parsedProbe()}>
                  {(p) => (
                    <div class="flex flex-wrap gap-1.5 text-[10.5px] font-mono-num">
                      <span
                        class="omnia-badge"
                        classList={{
                          'text-[var(--status-emerald)]': p().supportsRange,
                          'text-[var(--accent-amber)]': !p().supportsRange,
                        }}
                      >
                        {p().supportsRange ? 'HTTP 206 Range: READY' : 'Single-Stream Only'}
                      </span>
                      <span class="omnia-badge text-[var(--accent-cyan)]">
                        Size: {p().contentLength > 0 ? formatBytes(p().contentLength) : 'Unknown'}
                      </span>
                      <Show when={p().etag}>
                        <span class="omnia-badge">ETag: {p().etag.slice(0, 24)}</span>
                      </Show>
                      <Show when={p().crc32c}>
                        <span class="omnia-badge text-[var(--status-emerald)]">CRC32C: {p().crc32c}</span>
                      </Show>
                      <span class="omnia-badge text-[var(--ink-muted)]">DRM: Unsupported (false)</span>
                    </div>
                  )}
                </Show>

                <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(
                    maskJson(probeResult() ?? { hint: 'Inspect Accept-Ranges, Content-Length, RFC 9110 strong/weak ETag, and x-goog-hash CRC32C.' }, privacyMask()),
                    null,
                    2,
                  )}
                </pre>
              </div>

              {/* Smart Clip Range, autoGroupSeries & Per-Host Connection Cap */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3">
                <div class="font-bold text-[13px] flex items-center gap-2">
                  <Scissors class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>Smart Clip Range · autoGroupSeries · Per-Host Connection Cap</span>
                </div>

                <div class="space-y-2 p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[11px] font-semibold text-[var(--ink-secondary)]">Smart Clip Range (FFmpeg Stream Slice / Mux)</div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <input
                      type="text"
                      placeholder="External video path (D:\\OmniaData\\...)"
                      value={muxVideo()}
                      onInput={(e) => setMuxVideo(e.currentTarget.value)}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 font-mono-num"
                    />
                    <input
                      type="text"
                      placeholder="Optional audio path..."
                      value={muxAudio()}
                      onInput={(e) => setMuxAudio(e.currentTarget.value)}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 font-mono-num"
                    />
                  </div>
                  <div class="flex flex-wrap items-center gap-2 text-[11px]">
                    <label class="flex items-center gap-1">
                      <span class="text-[var(--ink-muted)]">clipStartSec:</span>
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        value={clipStartSec()}
                        onInput={(e) => setClipStartSec(e.currentTarget.value)}
                        class="w-20 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-0.5 font-mono-num"
                      />
                    </label>
                    <label class="flex items-center gap-1">
                      <span class="text-[var(--ink-muted)]">clipEndSec:</span>
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        value={clipEndSec()}
                        onInput={(e) => setClipEndSec(e.currentTarget.value)}
                        class="w-20 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-0.5 font-mono-num"
                      />
                    </label>
                    <input
                      type="text"
                      value={muxOutput()}
                      onInput={(e) => setMuxOutput(e.currentTarget.value)}
                      class="flex-1 min-w-[160px] rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-0.5 font-mono-num"
                    />
                    <button type="button" class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[11px]" onClick={() => void handleMux()}>
                      Clip & Mux
                    </button>
                  </div>
                </div>

                <div class="space-y-2 p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-[11px] font-semibold flex items-center gap-1.5">
                      <FolderTree class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
                      <span>autoGroupSeries Path-Safe Episode Folder Resolver</span>
                    </span>
                    <label class="flex items-center gap-1 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoGroupSeries()}
                        onChange={(e) => setAutoGroupSeries(e.currentTarget.checked)}
                      />
                      <span>Enabled</span>
                    </label>
                  </div>
                  <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
                    <input
                      type="text"
                      value={seriesSampleName()}
                      onInput={(e) => setSeriesSampleName(e.currentTarget.value)}
                      class="flex-1 min-w-[180px] rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1"
                    />
                    <span class="omnia-badge text-[var(--status-emerald)]">Folder: {seriesPreviewFolder()}</span>
                  </div>
                </div>

                <div class="space-y-2 p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[11px] font-semibold flex items-center gap-1.5">
                    <Sliders class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                    <span>Per-Host Connection Cap (`SitePolicyRegistry`)</span>
                  </div>
                  <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <input
                      type="text"
                      placeholder="*.example.org"
                      value={hostRulePattern()}
                      onInput={(e) => setHostRulePattern(e.currentTarget.value)}
                      class="flex-1 min-w-[130px] rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 font-mono-num"
                    />
                    <input
                      type="number"
                      min={1}
                      max={128}
                      value={hostRuleCap()}
                      onInput={(e) => setHostRuleCap(Number(e.currentTarget.value))}
                      class="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-1 font-mono-num"
                    />
                    <select
                      value={hostRulePacing()}
                      onChange={(e) => setHostRulePacing(e.currentTarget.value)}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-1"
                    >
                      <option value="adaptive">adaptive</option>
                      <option value="turbo">turbo</option>
                      <option value="polite">polite</option>
                      <option value="linear_rate_guarded">linear</option>
                    </select>
                    <button
                      type="button"
                      class="omnia-btn text-[11px]"
                      onClick={() => {
                        const pat = hostRulePattern().trim().toLowerCase();
                        if (!pat) return;
                        const cap = Math.max(1, Math.min(128, Number(hostRuleCap()) || 4));
                        setSiteRules((prev) => [
                          ...prev.filter((r) => r.host_pattern !== pat),
                          { host_pattern: pat, max_connections_per_host: cap, default_pacing: hostRulePacing(), note: 'User cap' },
                        ]);
                        void handleSaveScheduler();
                      }}
                    >
                      Add Cap
                    </button>
                  </div>
                  <div class="flex flex-wrap gap-1.5 text-[10.5px] font-mono-num">
                    <For each={siteRules()}>
                      {(r) => (
                        <span class="omnia-badge text-[var(--accent-cyan)]">
                          {r.host_pattern}: max {r.max_connections_per_host} ({r.default_pacing})
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Multi-Hash Integrity + .omnijrn / OMNF / PartMetaV2 Journal Inspector */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <FileCheck2 class="w-4 h-4 text-[var(--status-emerald)]" />
                <span>Streaming Multi-Hash Integrity Verifier (SHA-256 · MD5 · CRC32C)</span>
              </div>
              <input
                type="text"
                placeholder="External file path (D:\\OmniaData\\downloads\\archive.bin)"
                value={verifyPath()}
                onInput={(e) => setVerifyPath(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11.5px]"
              />
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  placeholder="Expected SHA-256 (64 hex)"
                  value={verifySha()}
                  onInput={(e) => setVerifySha(e.currentTarget.value)}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num text-[11px]"
                />
                <input
                  type="text"
                  placeholder="Expected MD5 (optional)"
                  value={verifyMd5()}
                  onInput={(e) => setVerifyMd5(e.currentTarget.value)}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num text-[11px]"
                />
                <input
                  type="text"
                  placeholder="Expected CRC32C Base64"
                  value={verifyCrc32c()}
                  onInput={(e) => setVerifyCrc32c(e.currentTarget.value)}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num text-[11px]"
                />
              </div>
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={() => void handleVerifyIntegrity()}
              >
                <ShieldCheck class="w-3.5 h-3.5" />
                <span>Verify SHA-256 / MD5 / CRC32C</span>
              </button>
              <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-40 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  maskJson(verifyResult() ?? { hint: 'Streams file in 64 KiB chunks computing SHA-256, MD5, and X-Goog-Hash CRC32C.' }, privacyMask()),
                  null,
                  2,
                )}
              </pre>

              <div class="pt-3 border-t border-[var(--border-subtle)] space-y-2">
                <div class="font-bold text-[12.5px] flex items-center justify-between gap-2">
                  <span>.omnijrn / OMNF Binary Journal & PartMetaV2 Sidecar Inspector</span>
                  <span class="omnia-badge text-[10px] font-mono-num text-[var(--accent-cyan)]">OMNF + CRC32</span>
                </div>
                <div class="flex gap-2">
                  <input
                    type="text"
                    placeholder="External path to .omnf, .omnijrn, or .part.meta..."
                    value={journalPath()}
                    onInput={(e) => setJournalPath(e.currentTarget.value)}
                    class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono-num text-[11.5px]"
                  />
                  <button
                    type="button"
                    class="omnia-btn text-[11.5px]"
                    onClick={async () => {
                      if (!journalPath().trim()) return;
                      const r = await api.inspectDriveJournal(journalPath().trim());
                      setJournalResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                      setStatusMsg(r.ok ? 'Inspected OMNF/PartMetaV2 journal' : `Journal (${r.error.code})`);
                    }}
                  >
                    Inspect Journal
                  </button>
                </div>
                <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-48 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(
                    maskJson(
                      journalResult() ?? {
                        hint: 'Replays OMNF binary frames with CRC32 verification and PartMetaV2 completed_ranges + If-Range ETag validator strength.',
                      },
                      privacyMask(),
                    ),
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          </div>
        </Show>

        {/* TAB 3: MANUAL_VISIBLE_BROWSER_ONLY Handoff Queue & 23-Provider Registry */}
        <Show when={studioTab() === 'handoff'}>
          <div class="space-y-4 text-[12px]">
            <div class="p-3 rounded-lg border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-2 font-semibold text-[var(--accent-amber)]">
                <ShieldAlert class="w-4 h-4 shrink-0" />
                <span class="font-mono-num">MANUAL_VISIBLE_BROWSER_ONLY</span>
                <span class="omnia-badge text-[var(--status-coral)] font-mono-num text-[10.5px]">
                  autoSolvePermitted: false
                </span>
                <span class="omnia-badge text-[var(--ink-secondary)] font-mono-num text-[10.5px]">
                  DRM_SUPPORTED: false
                </span>
              </div>
              <span class="text-[11px] font-mono-num text-[var(--ink-secondary)]">
                Zero CAPTCHA / Turnstile / hCaptcha / Altcha / ACL / DRM bypass — zero-retry fail-closed on 429/403.
              </span>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Handoff Queue */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-[13px]">Visible-Browser Handoff Queue ({handoffs().length})</span>
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadHandoffsAndProviders()}>
                    <RefreshCw class="w-3 h-3" />
                    <span>Refresh</span>
                  </button>
                </div>

                <div class="space-y-1.5">
                  <div class="flex flex-wrap gap-1.5">
                    <input
                      type="text"
                      value={handoffUrl()}
                      onInput={(e) => setHandoffUrl(e.currentTarget.value)}
                      placeholder="https://portal.example.org/protected"
                      class="flex-1 min-w-[180px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono-num text-[11.5px]"
                    />
                    <select
                      value={handoffReason()}
                      onChange={(e) => setHandoffReason(e.currentTarget.value)}
                      class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                    >
                      <option value="auth_challenge_required">AUTH_CHALLENGE_REQUIRED (429)</option>
                      <option value="sign_in_required">SIGN_IN_REQUIRED (401)</option>
                      <option value="blocked_acl_403">BLOCKED_ACL_403 (403)</option>
                      <option value="drm_unsupported">DRM_UNSUPPORTED (Refusal)</option>
                    </select>
                  </div>
                  <div class="flex gap-1.5">
                    <input
                      type="text"
                      value={handoffDetail()}
                      onInput={(e) => setHandoffDetail(e.currentTarget.value)}
                      placeholder="Human handoff note..."
                      class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[11.5px]"
                    />
                    <button
                      type="button"
                      data-testid="create-handoff-btn"
                      class="omnia-btn omnia-btn-primary text-[11px]"
                      onClick={async () => {
                        const r = await api.safeJson<Record<string, unknown>>('/api/omni-drive/handoffs/create', {
                          method: 'POST',
                          body: JSON.stringify({
                            url: handoffUrl().trim(),
                            reason: handoffReason(),
                            detail: handoffDetail().trim(),
                          }),
                        });
                        setStatusMsg(r.ok ? 'Created MANUAL_VISIBLE_BROWSER_ONLY ticket' : `Handoff (${r.error.code})`);
                        await loadHandoffsAndProviders();
                      }}
                    >
                      Create Ticket
                    </button>
                  </div>
                </div>

                <div class="space-y-2 max-h-80 overflow-y-auto">
                  <Show
                    when={handoffs().length > 0}
                    fallback={
                      <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                        No pending visible-browser handoffs. When a host returns HTTP 401/403/429 or a human challenge, a secret-free ticket appears here.
                      </div>
                    }
                  >
                    <For each={handoffs()}>
                      {(h) => {
                        const tid = String(h.ticket_id ?? h.ticketId ?? h.id ?? '');
                        const targetUrl = String(h.sanitized_url ?? h.sanitizedUrl ?? h.url ?? '');
                        const execMode = String(h.execution_mode ?? h.executionMode ?? 'MANUAL_VISIBLE_BROWSER_ONLY');
                        return (
                          <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-1.5">
                              <span class="font-mono-num font-bold text-[var(--accent-amber)] truncate max-w-[180px]">
                                {tid}
                              </span>
                              <div class="flex flex-wrap gap-1">
                                <span class="omnia-badge text-[9.5px] font-mono-num text-[var(--accent-amber)]">
                                  {execMode}
                                </span>
                                <span class="omnia-badge text-[9.5px] font-mono-num text-[var(--status-coral)]">
                                  autoSolvePermitted: false
                                </span>
                                <span class="omnia-badge text-[9.5px] font-mono-num">
                                  {String(h.status ?? 'pending_user_action')}
                                </span>
                              </div>
                            </div>
                            <div class="text-[11px] font-mono-num text-[var(--ink-secondary)] break-all">
                              {maskText(targetUrl, privacyMask())}
                            </div>
                            <Show when={h.guidance}>
                              <div class="text-[11px] text-[var(--ink-muted)]">{String(h.guidance)}</div>
                            </Show>
                            <div class="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10.5px]"
                                onClick={async () => {
                                  const r = await api.actDriveHandoff('open', tid);
                                  setStatusMsg(r.ok ? `Opened visible browser for ${tid}` : `Open (${r.error.code})`);
                                  await loadHandoffsAndProviders();
                                }}
                              >
                                <ExternalLink class="w-3 h-3" />
                                <span>Open Visible Browser</span>
                              </button>
                              <button
                                type="button"
                                class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
                                onClick={async () => {
                                  const r = await api.actDriveHandoff('resolve', tid);
                                  setStatusMsg(r.ok ? `Resolved ${tid}` : `Resolve (${r.error.code})`);
                                  await loadHandoffsAndProviders();
                                }}
                              >
                                Resolve
                              </button>
                              <button
                                type="button"
                                class="omnia-btn omnia-btn-danger px-2 py-0.5 text-[10.5px]"
                                onClick={async () => {
                                  const r = await api.actDriveHandoff('cancel', tid);
                                  setStatusMsg(r.ok ? `Cancelled ${tid}` : `Cancel (${r.error.code})`);
                                  await loadHandoffsAndProviders();
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>

              {/* Searchable 23-Provider Registry */}
              <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-[13px]">
                    Searchable 23-Provider Registry ({filteredProviders().length}/{providers().length})
                  </span>
                  <span class="omnia-badge text-[10px] font-mono-num text-[var(--status-emerald)]">10 Categories</span>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <input
                    type="text"
                    placeholder="Filter 23 providers (Google Drive, GitHub, Moodle, HLS, HuggingFace, S3...)"
                    value={providerQuery()}
                    onInput={(e) => setProviderQuery(e.currentTarget.value)}
                    class="flex-1 min-w-[160px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 text-[11.5px]"
                  />
                  <select
                    value={providerCategory()}
                    onChange={(e) => setProviderCategory(e.currentTarget.value)}
                    class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                  >
                    <For each={PROVIDER_CATEGORIES}>
                      {(c) => <option value={c.value}>{c.label}</option>}
                    </For>
                  </select>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-80 overflow-y-auto">
                  <For each={filteredProviders()}>
                    {(p) => {
                      const patterns = Array.isArray(p.host_patterns)
                        ? (p.host_patterns as unknown[]).map(String)
                        : Array.isArray(p.domains)
                          ? (p.domains as unknown[]).map(String)
                          : [];
                      const supportsRanges = Boolean(p.supports_ranges ?? p.supportsRanges);
                      return (
                        <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1 text-[11px] min-w-0">
                          <div class="flex items-center justify-between gap-1">
                            <span class="font-semibold text-[var(--accent-cyan)] truncate">{String(p.name ?? p.id)}</span>
                            <span class="omnia-badge text-[9.5px] font-mono-num shrink-0">{String(p.category ?? 'direct_http')}</span>
                          </div>
                          <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] truncate">
                            {patterns.join(', ') || '*'}
                          </div>
                          <div class="flex flex-wrap gap-1 text-[9.5px] font-mono-num">
                            <span
                              class="omnia-badge"
                              classList={{
                                'text-[var(--status-emerald)]': supportsRanges,
                                'text-[var(--ink-muted)]': !supportsRanges,
                              }}
                            >
                              {supportsRanges ? '206 Range' : 'Sequential'}
                            </span>
                            <span class="omnia-badge">
                              {Number(p.default_streams ?? p.defaultStreams ?? 1)} streams · {String(p.pacing_mode ?? p.pacingMode ?? 'adaptive')}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* TAB 4: Deep Protocol Diagnostics */}
        <Show when={studioTab() === 'protocol'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 text-[12px]">
            {/* 1. Binary Media Box Tree Inspector */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold text-[13px] flex items-center gap-1.5">
                  <Binary class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Binary Media Box Tree (ISO-BMFF · MPEG-TS · ADTS)</span>
                </span>
                <div class="flex flex-wrap gap-1">
                  <button
                    type="button"
                    class="omnia-btn px-2 py-0.5 text-[10px]"
                    onClick={() => setMediaMode(mediaMode() === 'hex' ? 'path' : 'hex')}
                  >
                    Mode: {mediaMode().toUpperCase()}
                  </button>
                  <Show when={mediaMode() === 'hex'}>
                    {(['fmp4', 'pssh', 'mpegts', 'adts'] as const).map((preset) => (
                      <button
                        type="button"
                        class="omnia-btn px-2 py-0.5 text-[10px] uppercase"
                        onClick={() => setMediaHex(MEDIA_HEX_PRESETS[preset])}
                      >
                        {preset}
                      </button>
                    ))}
                  </Show>
                </div>
              </div>

              <Show
                when={mediaMode() === 'hex'}
                fallback={
                  <input
                    type="text"
                    value={mediaFilePath()}
                    onInput={(e) => setMediaFilePath(e.currentTarget.value)}
                    placeholder="External path (D:\\OmniaData\\downloads\\sample.mp4)"
                    class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11px]"
                  />
                }
              >
                <textarea
                  rows={2}
                  value={mediaHex()}
                  onInput={(e) => setMediaHex(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono-num text-[11px]"
                />
              </Show>

              <button
                type="button"
                data-testid="inspect-media-box-btn"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={() => void handleInspectMedia()}
              >
                Inspect Binary Media Boxes
              </button>

              <Show when={parsedMediaReport()}>
                {(rep) => (
                  <div class="space-y-2 p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] font-mono-num text-[11px]">
                    <div class="flex flex-wrap gap-1.5">
                      <span class="omnia-badge text-[var(--accent-cyan)]">Format: {rep().format}</span>
                      <span class="omnia-badge">Bytes: {rep().bytesInspected}</span>
                      <Show when={rep().majorBrand}>
                        <span class="omnia-badge">Brand: {rep().majorBrand}</span>
                      </Show>
                      <Show when={rep().hasPssh || rep().drmDetected}>
                        <span class="omnia-badge text-[var(--status-coral)]">
                          READ-ONLY pssh/DRM DETECTED (drm_supported: false)
                        </span>
                      </Show>
                      <Show when={!rep().hasPssh && !rep().drmDetected}>
                        <span class="omnia-badge text-[var(--status-emerald)]">No pssh/DRM · drm_supported: false</span>
                      </Show>
                    </div>
                    <Show when={rep().isoBoxes.length > 0}>
                      <div class="space-y-1 max-h-32 overflow-y-auto">
                        <For each={rep().isoBoxes}>
                          {(box) => (
                            <div
                              class="flex items-center justify-between px-2 py-0.5 rounded bg-[var(--bg-panel)] border border-[var(--border-subtle)]"
                              style={{ 'margin-left': `${Math.min(Number(box.depth ?? 0), 4) * 12}px` }}
                            >
                              <span
                                class="font-bold"
                                classList={{
                                  'text-[var(--status-coral)]': String(box.box_type ?? box.boxType) === 'pssh',
                                  'text-[var(--accent-cyan)]': String(box.box_type ?? box.boxType) !== 'pssh',
                                }}
                              >
                                [{String(box.box_type ?? box.boxType)}]
                              </span>
                              <span class="text-[var(--ink-muted)]">
                                @{Number(box.offset ?? 0)} · {Number(box.size ?? 0)} B
                              </span>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-32 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  mediaTreeResult() ?? { hint: 'Inspect ISO-BMFF ftyp/moov/moof/mdat + read-only pssh flag, MPEG-TS 0x47 PIDs, or ADTS 0xFFF sync.' },
                  null,
                  2,
                )}
              </pre>
            </div>

            {/* 2. 3-Gram Jaccard Schema Drift Diff Table */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold text-[13px] flex items-center gap-1.5">
                  <Sparkles class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>3-Gram Jaccard Schema Drift Diff Table</span>
                </span>
                <label class="flex items-center gap-1.5 text-[11px] font-mono-num">
                  <span class="text-[var(--ink-muted)]">Threshold:</span>
                  <input
                    type="number"
                    min={0.3}
                    max={0.95}
                    step={0.05}
                    value={driftThreshold()}
                    onInput={(e) => setDriftThreshold(Number(e.currentTarget.value))}
                    class="w-16 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5"
                  />
                </label>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <textarea
                  rows={2}
                  value={driftBefore()}
                  onInput={(e) => setDriftBefore(e.currentTarget.value)}
                  placeholder="Baseline JSON/HTML/text schema..."
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono-num text-[11px]"
                />
                <textarea
                  rows={2}
                  value={driftAfter()}
                  onInput={(e) => setDriftAfter(e.currentTarget.value)}
                  placeholder="Observed JSON/HTML/text schema..."
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono-num text-[11px]"
                />
              </div>
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={() => void handleDriftCompare()}
              >
                Compare 3-Gram Jaccard Drift
              </button>

              <Show when={parsedDrift()}>
                {(dr) => (
                  <div class="space-y-2">
                    <div class="flex flex-wrap gap-1.5 text-[10.5px] font-mono-num">
                      <span
                        class="omnia-badge"
                        classList={{
                          'text-[var(--accent-amber)]': dr().driftDetected,
                          'text-[var(--status-emerald)]': !dr().driftDetected,
                        }}
                      >
                        {dr().driftDetected ? 'DRIFT DETECTED' : 'CONFORMANT'}
                      </span>
                      <For each={dr().added}>
                        {(a) => <span class="omnia-badge text-[var(--status-emerald)]">+ {a}</span>}
                      </For>
                      <For each={dr().gone}>
                        {(g) => <span class="omnia-badge text-[var(--status-coral)]">- {g}</span>}
                      </For>
                    </div>
                    <Show when={dr().pairs.length > 0}>
                      <div class="max-h-32 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                        <table class="w-full text-left border-collapse text-[10.5px] font-mono-num">
                          <thead class="bg-[var(--bg-elevated)] text-[var(--ink-muted)]">
                            <tr>
                              <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Before</th>
                              <th class="px-2 py-1 border-b border-[var(--border-subtle)]">After</th>
                              <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Verdict</th>
                              <th class="px-2 py-1 border-b border-[var(--border-subtle)]">Jaccard</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={dr().pairs}>
                              {(pair) => {
                                const v = String(pair.verdict ?? 'edited');
                                const sim = Number(pair.similarity ?? 0) * 100;
                                return (
                                  <tr class="border-b border-[var(--border-subtle)] last:border-b-0">
                                    <td class="px-2 py-1">{String(pair.before ?? '')}</td>
                                    <td class="px-2 py-1">{String(pair.after ?? '')}</td>
                                    <td
                                      class="px-2 py-1 uppercase"
                                      classList={{
                                        'text-[var(--status-emerald)]': v === 'identical',
                                        'text-[var(--accent-amber)]': v === 'renamed',
                                        'text-[var(--accent-cyan)]': v === 'edited',
                                      }}
                                    >
                                      {v}
                                    </td>
                                    <td class="px-2 py-1">{sim.toFixed(1)}%</td>
                                  </tr>
                                );
                              }}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={!parsedDrift() || parsedDrift()!.pairs.length === 0}>
                <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-32 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(driftResult() ?? { hint: 'Compare baseline vs current JSON/HTML responses to detect renamed/edited/added/gone fields.' }, null, 2)}
                </pre>
              </Show>
            </div>

            {/* 3. RFC 6265 Scoped Cookie Evaluator */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold text-[13px] flex items-center gap-1.5">
                  <Cookie class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>RFC 6265 Scoped Cookie Evaluator (In-Memory Sandbox)</span>
                </span>
                <select
                  value={cookieSameSite()}
                  onChange={(e) => setCookieSameSite(e.currentTarget.value as 'strict' | 'lax' | 'none')}
                  class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px]"
                >
                  <option value="strict">SameSite: Strict</option>
                  <option value="lax">SameSite: Lax</option>
                  <option value="none">SameSite: None</option>
                </select>
              </div>
              <input
                type="text"
                value={cookieUrl()}
                onInput={(e) => setCookieUrl(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1 font-mono-num text-[11.5px]"
              />
              <textarea
                rows={3}
                value={cookieHeaders()}
                onInput={(e) => setCookieHeaders(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2 font-mono-num text-[11px]"
              />
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={async () => {
                  const lines = cookieHeaders().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                  const r = await api.evaluateDriveCookies(cookieUrl().trim(), lines, cookieSameSite());
                  setCookieResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                  setStatusMsg(r.ok ? 'Evaluated RFC 6265 cookie scope & PSL rules' : `Cookie (${r.error.code})`);
                }}
              >
                Evaluate RFC 6265 Scope
              </button>
              <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-36 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  maskJson(cookieResult() ?? { hint: 'Tests Domain/Path/Secure/HttpOnly/Public-Suffix isolation without persisting credentials.' }, privacyMask()),
                  null,
                  2,
                )}
              </pre>
            </div>

            {/* 4. Strategy Recommender + AIMD/BDP Telemetry + CAS CaptureBundle Browser */}
            <div class="omnia-surface-panel rounded-lg p-4 space-y-3 min-w-0">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold text-[13px]">Strategy Recommender · AIMD/BDP · CAS Bundles</span>
                <div class="flex gap-1.5">
                  <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void loadAimdAndScheduler()}>
                    <RefreshCw class="w-3 h-3" />
                    <span>AIMD</span>
                  </button>
                  <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={() => void handleSealBundle()}>
                    <PackageCheck class="w-3 h-3 text-[var(--status-emerald)]" />
                    <span>Seal Bundle</span>
                  </button>
                </div>
              </div>

              {/* AIMD/BDP Telemetry KPI Strip */}
              <div class="grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-[10.5px] font-mono-num">
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">cwnd</div>
                  <div class="font-bold text-[var(--accent-cyan)]">
                    {parsedAimd()?.currentWindow ?? 0}/{parsedAimd()?.maxWindow ?? 16}
                  </div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">ssthresh</div>
                  <div class="font-bold">{parsedAimd()?.ssthresh ?? 0}</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">RTT</div>
                  <div class="font-bold">{(parsedAimd()?.rttMs ?? 0).toFixed(1)}ms</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">Est BW</div>
                  <div class="font-bold">{formatBytes(parsedAimd()?.bwBps ?? 0)}/s</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">BDP</div>
                  <div class="font-bold">{formatBytes(parsedAimd()?.bdpBytes ?? 0)}</div>
                </div>
                <div class="p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)]">
                  <div class="text-[9.5px] text-[var(--ink-muted)]">Backoffs</div>
                  <div class="font-bold text-[var(--accent-amber)]">{parsedAimd()?.backoffs ?? 0}</div>
                </div>
              </div>

              {/* Strategy Recommender */}
              <div class="flex flex-wrap items-center gap-2 text-[11px]">
                <label class="flex items-center gap-1">
                  <span>Size (MiB):</span>
                  <input
                    type="number"
                    value={recSizeMb()}
                    onInput={(e) => setRecSizeMb(Number(e.currentTarget.value))}
                    class="w-20 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-0.5 font-mono-num"
                  />
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={recRange()} onChange={(e) => setRecRange(e.currentTarget.checked)} />
                  <span>206 Range</span>
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={recEtag()} onChange={(e) => setRecEtag(e.currentTarget.checked)} />
                  <span>Strong ETag</span>
                </label>
                <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={recAuth()} onChange={(e) => setRecAuth(e.currentTarget.checked)} />
                  <span>Auth Gate</span>
                </label>
                <button
                  type="button"
                  class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[11px]"
                  onClick={async () => {
                    const r = await api.recommendDriveStrategy({
                      url: probeUrlInput().trim(),
                      fileSizeBytes: recSizeMb() * 1024 * 1024,
                      supportsRange: recRange(),
                      hasStrongEtag: recEtag(),
                      requiresAuth: recAuth(),
                    });
                    setRecResult(r.ok ? r.data : { error: r.error.code, message: r.error.message });
                    setStatusMsg(r.ok ? 'Computed AIMD+BDP transfer strategy' : `Recommend (${r.error.code})`);
                  }}
                >
                  Recommend
                </button>
              </div>

              {/* CAS CaptureBundle Browser */}
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[11px] font-semibold">
                  <span>CAS CaptureBundle Browser ({bundles().length})</span>
                  <button type="button" class="omnia-btn px-2 py-0.5 text-[10px]" onClick={() => void loadBundles()}>
                    Refresh Bundles
                  </button>
                </div>
                <Show when={bundles().length > 0}>
                  <div class="space-y-1 max-h-28 overflow-y-auto text-[10.5px] font-mono-num">
                    <For each={bundles()}>
                      {(b) => {
                        const bid = String(b.bundle_id ?? b.bundleId ?? b.id ?? 'cap_bundle');
                        const digest = String(b.manifest_sha256 ?? b.sha256 ?? '');
                        return (
                          <div class="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2">
                            <div class="min-w-0 truncate">
                              <span class="text-[var(--accent-cyan)] font-bold">{bid}</span>
                              <Show when={digest}>
                                <span class="text-[var(--status-emerald)] ml-2">sha256:{digest.slice(0, 12)}</span>
                              </Show>
                            </div>
                            <button
                              type="button"
                              class="omnia-btn px-2 py-0.5 text-[10px] shrink-0"
                              onClick={() => void handleVerifyBundle(b)}
                            >
                              Verify
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>

              <pre class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-28 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(
                  maskJson(bundleVerifyResult() ?? recResult() ?? inspectorPayload() ?? { status: 'Ready' }, privacyMask()),
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
