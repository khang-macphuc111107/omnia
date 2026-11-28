import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Columns2,
  Copy,
  Download,
  Eye,
  FileCode2,
  GitCompare,
  History,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Sparkles,
  Table,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-solid';
import { handleRichMarkdownClick, renderRichMarkdown } from '@/utils/markdown';
import { downloadTextFile } from '@/utils/privacy';

export interface CanvasArtifact {
  id: string;
  title: string;
  kind: 'html' | 'svg' | 'mermaid' | 'markdown' | 'code' | 'csv' | 'json';
  language?: string;
  content: string;
  versions?: Array<{ label: string; content: string; ts: number }>;
  sourceMsgId?: string;
}

interface ArtifactVersion {
  label: string;
  content: string;
  ts: number;
}

type DrawerTab = 'preview' | 'code' | 'split' | 'diff';

interface ParsedTableData {
  columns: string[];
  rows: string[][];
  error?: string;
  note?: string;
}

interface DiffLine {
  kind: 'same' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

const OFFLINE_IFRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;";

const KIND_LABELS: Record<CanvasArtifact['kind'], string> = {
  html: 'HTML',
  svg: 'SVG',
  mermaid: 'MERMAID',
  markdown: 'MARKDOWN',
  code: 'CODE',
  csv: 'CSV',
  json: 'JSON',
};

const CODE_LANG_EXT: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  python: 'py',
  py: 'py',
  rust: 'rs',
  rs: 'rs',
  css: 'css',
  html: 'html',
  svg: 'svg',
  json: 'json',
  csv: 'csv',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  go: 'go',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  markdown: 'md',
  md: 'md',
  mermaid: 'mmd',
};

const REFINE_PRESETS = [
  { label: 'Polish layout', prompt: 'Improve visual hierarchy, spacing, and contrast while keeping everything self-contained.' },
  { label: 'Fix bugs', prompt: 'Audit for edge cases or syntax issues and fix any defects cleanly.' },
  { label: 'Add interactivity', prompt: 'Add useful client-side interactivity and keyboard ergonomics with zero external dependencies.' },
  { label: 'Simplify', prompt: 'Make this cleaner, more concise, and easier to read without losing functionality.' },
];

let mermaidLib: typeof import('mermaid').default | null = null;
let canvasMermaidSeq = 0;

function readActiveThemeSurface(): { bg: string; fg: string; light: boolean } {
  if (typeof document === 'undefined') {
    return { bg: '#111621', fg: '#F2F5FA', light: false };
  }
  const theme = document.documentElement.getAttribute('data-theme') || 'obsidian';
  const light = theme === 'alabaster';
  const cs = getComputedStyle(document.documentElement);
  return {
    bg: cs.getPropertyValue('--bg-panel').trim() || (light ? '#FFFFFF' : '#111621'),
    fg: cs.getPropertyValue('--ink-primary').trim() || (light ? '#11141C' : '#F2F5FA'),
    light,
  };
}

function buildSandboxedHtmlDoc(raw: string): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_IFRAME_CSP}">`;
  const trimmed = raw.trim();
  if (/<head[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<head([^>]*)>/i, `<head$1>${cspMeta}`);
  }
  if (/<html[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${cspMeta}</head>`);
  }
  const surface = readActiveThemeSurface();
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    cspMeta,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>*,*::before,*::after{box-sizing:border-box;}html,body{margin:0;padding:14px;background:${surface.bg};color:${surface.fg};font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;}</style>`,
    '</head>',
    '<body>',
    raw,
    '</body>',
    '</html>',
  ].join('\n');
}

function buildSandboxedSvgDoc(raw: string, zoomPct: number, lightCanvas: boolean): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${OFFLINE_IFRAME_CSP}">`;
  const bg = lightCanvas ? '#F8F9FA' : '#0E131D';
  const fg = lightCanvas ? '#11141C' : '#F2F5FA';
  const scale = Math.max(0.25, Math.min(3, zoomPct / 100));
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    cspMeta,
    `<style>html,body{margin:0;width:100%;height:100%;background:${bg};color:${fg};font-family:system-ui,sans-serif;overflow:auto;}#stage{min-width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}#zoom{transform:scale(${scale});transform-origin:center center;display:inline-flex;align-items:center;justify-content:center;}svg{max-width:100%;height:auto;display:block;}</style>`,
    '</head>',
    '<body>',
    `<div id="stage"><div id="zoom">${raw}</div></div>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseCsvToTable(raw: string): ParsedTableData {
  const clean = raw.replace(/^\uFEFF/, '').trim();
  if (!clean) return { columns: [], rows: [], note: 'Empty CSV artifact' };
  const delimiter = detectDelimiter(clean);
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r') {
      continue;
    } else if (ch === '\n') {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) matrix.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) matrix.push(row);

  if (matrix.length === 0) return { columns: [], rows: [], note: 'No rows detected' };
  const maxCols = matrix.reduce((acc, r) => Math.max(acc, r.length), 0);
  const header = matrix[0].map((c, idx) => c || `Col ${idx + 1}`);
  while (header.length < maxCols) header.push(`Col ${header.length + 1}`);
  const rows = matrix.slice(1).map((r) => {
    const copy = [...r];
    while (copy.length < maxCols) copy.push('');
    return copy;
  });
  return { columns: header, rows };
}

function stringifyCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function parseJsonToTable(raw: string): ParsedTableData {
  const clean = raw.trim();
  if (!clean) return { columns: [], rows: [], note: 'Empty JSON artifact' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    return {
      columns: [],
      rows: [],
      error: err instanceof Error ? err.message : 'Invalid JSON syntax',
    };
  }

  let listCandidate: unknown[] | null = null;
  let sourceNote: string | undefined;

  if (Array.isArray(parsed)) {
    listCandidate = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    for (const key of ['rows', 'items', 'data', 'records', 'results', 'entries']) {
      if (Array.isArray(rec[key]) && (rec[key] as unknown[]).length > 0) {
        listCandidate = rec[key] as unknown[];
        sourceNote = `Extracted array from ".${key}"`;
        break;
      }
    }
    if (!listCandidate) {
      const entries = Object.entries(rec);
      return {
        columns: ['Key', 'Type', 'Value'],
        rows: entries.map(([k, v]) => [
          k,
          Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v,
          stringifyCell(v),
        ]),
        note: 'Object key/value view',
      };
    }
  } else {
    return {
      columns: ['Value'],
      rows: [[stringifyCell(parsed)]],
      note: 'Scalar JSON value',
    };
  }

  if (listCandidate.length === 0) {
    return { columns: ['Index', 'Value'], rows: [], note: 'Empty JSON array' };
  }

  const hasObjects = listCandidate.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  if (!hasObjects) {
    return {
      columns: ['Index', 'Value'],
      rows: listCandidate.map((item, idx) => [String(idx), stringifyCell(item)]),
      note: sourceNote,
    };
  }

  const keySet: string[] = [];
  for (const item of listCandidate) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!keySet.includes(k)) keySet.push(k);
      }
    }
  }
  const rows = listCandidate.map((item) => {
    const rec = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item };
    return keySet.map((k) => stringifyCell(rec[k]));
  });
  return { columns: keySet, rows, note: sourceNote };
}

function computeLineDiff(beforeText: string, afterText: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = beforeText.replace(/\r\n/g, '\n').split('\n');
  const b = afterText.replace(/\r\n/g, '\n').split('\n');
  const m = a.length;
  const n = b.length;

  // Bounded DP fallback for very large files so UI stays responsive
  if (m * n > 160000) {
    const lines: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    const maxLen = Math.max(m, n);
    for (let i = 0; i < maxLen; i++) {
      const av = i < m ? a[i] : undefined;
      const bv = i < n ? b[i] : undefined;
      if (av === bv && av !== undefined) {
        lines.push({ kind: 'same', oldLine: i + 1, newLine: i + 1, text: av });
      } else {
        if (av !== undefined) {
          lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text: av });
          removed++;
        }
        if (bv !== undefined) {
          lines.push({ kind: 'add', oldLine: null, newLine: i + 1, text: bv });
          added++;
        }
      }
    }
    return { lines, added, removed };
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] });
      removed++;
      i++;
    } else {
      lines.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] });
      added++;
      j++;
    }
  }
  while (i < m) {
    lines.push({ kind: 'del', oldLine: i + 1, newLine: null, text: a[i] });
    removed++;
    i++;
  }
  while (j < n) {
    lines.push({ kind: 'add', oldLine: null, newLine: j + 1, text: b[j] });
    added++;
    j++;
  }
  return { lines, added, removed };
}

function downloadExtension(artifact: CanvasArtifact): string {
  if (artifact.kind === 'html') return 'html';
  if (artifact.kind === 'svg') return 'svg';
  if (artifact.kind === 'markdown') return 'md';
  if (artifact.kind === 'mermaid') return 'mmd';
  if (artifact.kind === 'csv') return 'csv';
  if (artifact.kind === 'json') return 'json';
  const lang = (artifact.language || '').trim().toLowerCase();
  return CODE_LANG_EXT[lang] || 'txt';
}

function downloadMime(ext: string): string {
  if (ext === 'html') return 'text/html;charset=utf-8';
  if (ext === 'svg') return 'image/svg+xml;charset=utf-8';
  if (ext === 'md') return 'text/markdown;charset=utf-8';
  if (ext === 'csv') return 'text/csv;charset=utf-8';
  if (ext === 'json') return 'application/json;charset=utf-8';
  return 'text/plain;charset=utf-8';
}

function sanitizeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'omnia-artifact';
}

async function hydrateCanvasMermaid(container: HTMLElement): Promise<void> {
  const nodes = container.querySelectorAll<HTMLElement>('.omnia-mermaid[data-mermaid]');
  if (nodes.length === 0) return;
  if (!mermaidLib) {
    const mod = await import('mermaid');
    mermaidLib = mod.default;
  }
  const light = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'alabaster';
  mermaidLib.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: light ? 'default' : 'dark',
  });
  for (const el of nodes) {
    const raw = decodeURIComponent(el.dataset.mermaid || '');
    if (!raw.trim()) continue;
    try {
      const id = `omnia-canvas-mmd-${++canvasMermaidSeq}`;
      const { svg } = await mermaidLib.render(id, raw);
      el.innerHTML = svg;
      el.dataset.rendered = 'true';
    } catch {
      // Keep clean source fallback
    }
  }
}

export function ArtifactCanvasDrawer(props: {
  open: boolean;
  artifact: CanvasArtifact | null;
  onClose: () => void;
  onUpdateContent: (content: string, label?: string) => void;
  onAskRefine: (instruction: string, currentContent: string) => void;
}) {
  const [activeTab, setActiveTab] = createSignal<DrawerTab>('preview');
  const [expanded, setExpanded] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [selectedVersionIdx, setSelectedVersionIdx] = createSignal(0);
  const [diffBaseIdx, setDiffBaseIdx] = createSignal(0);
  const [localVersions, setLocalVersions] = createSignal<ArtifactVersion[]>([]);
  const [lastArtifactId, setLastArtifactId] = createSignal<string | null>(null);
  const [lastSyncedContent, setLastSyncedContent] = createSignal<string>('');
  const [refineInput, setRefineInput] = createSignal('');
  const [copied, setCopied] = createSignal(false);
  const [statusNote, setStatusNote] = createSignal('');
  const [iframeRefreshSeq, setIframeRefreshSeq] = createSignal(0);
  const [svgZoom, setSvgZoom] = createSignal(100);
  const [svgLightBg, setSvgLightBg] = createSignal(false);

  // Table state for csv/json preview
  const [tableFilter, setTableFilter] = createSignal('');
  const [sortCol, setSortCol] = createSignal<number | null>(null);
  const [sortDir, setSortDir] = createSignal<'asc' | 'desc'>('asc');
  const [jsonViewMode, setJsonViewMode] = createSignal<'table' | 'formatted'>('table');

  let markdownHostRef: HTMLDivElement | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (msg: string) => {
    setStatusNote(msg);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setStatusNote(''), 2200);
  };

  // Build normalized version timeline merging parent artifact versions with local snapshots
  const versions = createMemo<ArtifactVersion[]>(() => {
    const art = props.artifact;
    if (!art) return [];
    const propVers = Array.isArray(art.versions) && art.versions.length > 0 ? art.versions : [];
    if (propVers.length > 0) {
      const merged = [...propVers];
      for (const lv of localVersions()) {
        if (!merged.some((v) => v.content === lv.content && v.label === lv.label)) {
          merged.push(lv);
        }
      }
      return merged;
    }
    const base: ArtifactVersion[] = [{ label: 'Initial', content: art.content, ts: Date.now() }];
    for (const lv of localVersions()) {
      if (lv.content !== art.content) base.push(lv);
    }
    return base;
  });

  // Synchronize draft & version index when opening a new artifact or receiving new external content
  createEffect(() => {
    const art = props.artifact;
    if (!art) {
      setLastArtifactId(null);
      return;
    }
    const propVers = Array.isArray(art.versions) ? art.versions : [];
    if (art.id !== lastArtifactId()) {
      setLastArtifactId(art.id);
      setLocalVersions([]);
      setDraft(art.content);
      setLastSyncedContent(art.content);
      const latestIdx = Math.max(0, propVers.length - 1);
      setSelectedVersionIdx(latestIdx);
      setDiffBaseIdx(Math.max(0, latestIdx - 1));
      setTableFilter('');
      setSortCol(null);
      setSortDir('asc');
      setSvgZoom(100);
      setActiveTab('preview');
      return;
    }
    if (art.content !== lastSyncedContent()) {
      setDraft(art.content);
      setLastSyncedContent(art.content);
      const total = versions().length;
      const latestIdx = Math.max(0, total - 1);
      setSelectedVersionIdx(latestIdx);
      setDiffBaseIdx(Math.max(0, latestIdx - 1));
    }
  });

  const activeVersion = createMemo<ArtifactVersion | null>(() => {
    const list = versions();
    if (list.length === 0) return null;
    const idx = Math.max(0, Math.min(selectedVersionIdx(), list.length - 1));
    return list[idx];
  });

  const isDirty = createMemo(() => {
    const v = activeVersion();
    return v ? draft() !== v.content : false;
  });

  const selectVersion = (idx: number) => {
    const list = versions();
    if (idx < 0 || idx >= list.length) return;
    setSelectedVersionIdx(idx);
    setDraft(list[idx].content);
    setDiffBaseIdx(Math.max(0, idx - 1));
  };

  const commitManualVersion = () => {
    const art = props.artifact;
    if (!art) return;
    const current = draft();
    const label = `Edit v${versions().length + 1}`;
    const nextVer: ArtifactVersion = { label, content: current, ts: Date.now() };
    setLocalVersions((prev) => [...prev, nextVer]);
    setLastSyncedContent(current);
    props.onUpdateContent(current, label);
    const nextIdx = versions().length - 1;
    setSelectedVersionIdx(Math.max(0, nextIdx));
    setDiffBaseIdx(Math.max(0, nextIdx - 1));
    notify(`Saved ${label}`);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft());
      setCopied(true);
      notify('Copied artifact to clipboard');
      setTimeout(() => setCopied(false), 1600);
    } catch {
      notify('Clipboard unavailable');
    }
  };

  const handleDownload = () => {
    const art = props.artifact;
    if (!art) return;
    const ext = downloadExtension(art);
    const filename = `${sanitizeFilename(art.title)}.${ext}`;
    downloadTextFile(filename, draft(), downloadMime(ext));
    notify(`Downloaded ${filename}`);
  };

  const handleFormatJson = () => {
    try {
      const formatted = JSON.stringify(JSON.parse(draft()), null, 2);
      setDraft(formatted);
      notify('Formatted JSON');
    } catch (err) {
      notify(`JSON syntax error: ${err instanceof Error ? err.message : 'invalid'}`);
    }
  };

  const handleRefineSubmit = (customInstruction?: string) => {
    const inst = (customInstruction ?? refineInput()).trim();
    if (!inst) return;
    props.onAskRefine(inst, draft());
    if (!customInstruction) setRefineInput('');
    notify('Sent refinement request to Omnia');
  };

  // Preview computations
  const previewMarkdownHtml = createMemo(() => {
    const art = props.artifact;
    if (!art) return '';
    const text = draft();
    if (art.kind === 'markdown') {
      return renderRichMarkdown(text);
    }
    if (art.kind === 'mermaid') {
      const fenced = /^\s*(?:```|~~~)mermaid/i.test(text) ? text : `\`\`\`mermaid\n${text}\n\`\`\``;
      return renderRichMarkdown(fenced);
    }
    if (art.kind === 'code') {
      const lang = (art.language || 'text').replace(/[^a-z0-9_+#.-]/gi, '') || 'text';
      return renderRichMarkdown(`\`\`\`${lang}\n${text}\n\`\`\``);
    }
    return '';
  });

  createEffect(() => {
    const tab = activeTab();
    const html = previewMarkdownHtml();
    if (!html || (tab !== 'preview' && tab !== 'split')) return;
    if (markdownHostRef) {
      queueMicrotask(() => {
        if (markdownHostRef) void hydrateCanvasMermaid(markdownHostRef);
      });
    }
  });

  const sandboxedSrcDoc = createMemo(() => {
    const art = props.artifact;
    iframeRefreshSeq();
    if (!art) return '';
    if (art.kind === 'html') return buildSandboxedHtmlDoc(draft());
    if (art.kind === 'svg') return buildSandboxedSvgDoc(draft(), svgZoom(), svgLightBg());
    return '';
  });

  const parsedTable = createMemo<ParsedTableData>(() => {
    const art = props.artifact;
    if (!art) return { columns: [], rows: [] };
    if (art.kind === 'csv') return parseCsvToTable(draft());
    if (art.kind === 'json') return parseJsonToTable(draft());
    return { columns: [], rows: [] };
  });

  const filteredSortedRows = createMemo<string[][]>(() => {
    const data = parsedTable();
    const q = tableFilter().trim().toLowerCase();
    let rows = q
      ? data.rows.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)))
      : [...data.rows];
    const col = sortCol();
    if (col !== null && col >= 0 && col < data.columns.length) {
      const dir = sortDir() === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[col] ?? '';
        const bv = b[col] ?? '';
        const an = Number(av);
        const bn = Number(bv);
        if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) {
          return (an - bn) * dir;
        }
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    return rows;
  });

  const formattedJsonText = createMemo(() => {
    if (props.artifact?.kind !== 'json') return '';
    try {
      return JSON.stringify(JSON.parse(draft()), null, 2);
    } catch {
      return draft();
    }
  });

  const toggleColumnSort = (idx: number) => {
    if (sortCol() === idx) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(idx);
      setSortDir('asc');
    }
  };

  const diffComputation = createMemo(() => {
    const list = versions();
    const safeBase = Math.max(0, Math.min(diffBaseIdx(), Math.max(0, list.length - 1)));
    const baseText = list[safeBase]?.content ?? '';
    const currText = draft();
    return {
      baseLabel: `v${safeBase + 1}${list[safeBase]?.label ? ` · ${list[safeBase].label}` : ''}`,
      currLabel: isDirty()
        ? `v${selectedVersionIdx() + 1} (unsaved draft)`
        : `v${selectedVersionIdx() + 1}${activeVersion()?.label ? ` · ${activeVersion()?.label}` : ''}`,
      ...computeLineDiff(baseText, currText),
    };
  });

  const renderPreviewPane = () => {
    const art = props.artifact;
    if (!art) return null;

    if (art.kind === 'html' || art.kind === 'svg') {
      return (
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
          <div class="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-1.5 text-[11px] min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="omnia-badge text-[var(--status-emerald)]">Sandboxed CSP · Offline</span>
              <span class="font-mono-num text-[var(--ink-muted)] truncate">
                {art.kind === 'html' ? 'sandbox="allow-scripts"' : `SVG ${svgZoom()}%`}
              </span>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <Show when={art.kind === 'svg'}>
                <button
                  type="button"
                  class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                  title="Zoom out"
                  onClick={() => setSvgZoom((z) => Math.max(50, z - 25))}
                >
                  <ZoomOut class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="omnia-btn px-1.5 py-0.5 text-[10.5px] font-mono-num"
                  title="Reset zoom"
                  onClick={() => setSvgZoom(100)}
                >
                  {svgZoom()}%
                </button>
                <button
                  type="button"
                  class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                  title="Zoom in"
                  onClick={() => setSvgZoom((z) => Math.min(250, z + 25))}
                >
                  <ZoomIn class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                  title="Toggle SVG backdrop"
                  onClick={() => setSvgLightBg((v) => !v)}
                >
                  {svgLightBg() ? 'Dark BG' : 'Light BG'}
                </button>
              </Show>
              <button
                type="button"
                class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                title="Reload preview"
                onClick={() => setIframeRefreshSeq((n) => n + 1)}
              >
                <RefreshCw class="w-3 h-3" />
              </button>
            </div>
          </div>
          <iframe
            data-testid="canvas-sandbox-iframe"
            title={`Sandboxed ${art.kind.toUpperCase()} preview: ${art.title}`}
            sandbox="allow-scripts"
            srcdoc={sandboxedSrcDoc()}
            class="flex-1 w-full min-h-[260px] border-0 bg-[var(--bg-panel)]"
          />
        </div>
      );
    }

    if (art.kind === 'csv' || art.kind === 'json') {
      const table = parsedTable();
      const rows = filteredSortedRows();
      return (
        <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
          <div class="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2 min-w-0">
            <div class="flex items-center gap-1.5 flex-1 min-w-[140px]">
              <Search class="w-3.5 h-3.5 text-[var(--ink-muted)] shrink-0" />
              <input
                type="text"
                value={tableFilter()}
                onInput={(e) => setTableFilter(e.currentTarget.value)}
                placeholder="Filter rows..."
                class="w-full min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11.5px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
              />
            </div>
            <div class="flex items-center gap-1.5 shrink-0 text-[11px] font-mono-num">
              <span class="text-[var(--ink-muted)]">
                {rows.length}/{table.rows.length} rows · {table.columns.length} cols
              </span>
              <Show when={art.kind === 'json'}>
                <div class="omp-segmented">
                  <button
                    type="button"
                    aria-pressed={jsonViewMode() === 'table'}
                    onClick={() => setJsonViewMode('table')}
                    class="!px-2 !py-0.5 !text-[10.5px]"
                  >
                    Table
                  </button>
                  <button
                    type="button"
                    aria-pressed={jsonViewMode() === 'formatted'}
                    onClick={() => setJsonViewMode('formatted')}
                    class="!px-2 !py-0.5 !text-[10.5px]"
                  >
                    JSON
                  </button>
                </div>
              </Show>
            </div>
          </div>

          <Show when={table.error}>
            <div class="m-2.5 p-2.5 rounded border border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[11.5px] text-[var(--status-coral)] flex items-start gap-2">
              <AlertTriangle class="w-4 h-4 shrink-0 mt-0.5" />
              <span class="font-mono-num break-all">{table.error}</span>
            </div>
          </Show>

          <Show
            when={art.kind === 'json' && jsonViewMode() === 'formatted'}
            fallback={
              <div class="flex-1 min-h-0 min-w-0 overflow-auto p-2.5">
                <Show
                  when={table.columns.length > 0}
                  fallback={
                    <div class="p-4 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px] text-[var(--ink-muted)]">
                      {table.note || 'No tabular data to display.'}
                    </div>
                  }
                >
                  <Show when={table.note}>
                    <div class="mb-2 text-[11px] font-mono-num text-[var(--ink-muted)]">{table.note}</div>
                  </Show>
                  <table class="w-full border-collapse text-[12px] font-mono-num">
                    <thead class="sticky top-0 z-10 bg-[var(--bg-elevated)]">
                      <tr>
                        <For each={table.columns}>
                          {(col, colIdx) => (
                            <th class="border border-[var(--border-subtle)] px-2.5 py-1.5 text-left font-semibold text-[var(--ink-primary)] whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => toggleColumnSort(colIdx())}
                                class="inline-flex items-center gap-1 cursor-pointer hover:text-[var(--accent-cyan)]"
                              >
                                <span>{col}</span>
                                <ArrowUpDown class="w-3 h-3 text-[var(--ink-muted)]" />
                                <Show when={sortCol() === colIdx()}>
                                  <span class="text-[10px] text-[var(--accent-cyan)]">
                                    {sortDir() === 'asc' ? 'ASC' : 'DESC'}
                                  </span>
                                </Show>
                              </button>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rows}>
                        {(r) => (
                          <tr class="hover:bg-[var(--bg-elevated)]">
                            <For each={r}>
                              {(val) => (
                                <td
                                  class="border border-[var(--border-subtle)] px-2.5 py-1.5 text-[var(--ink-secondary)] max-w-[260px] truncate cursor-pointer"
                                  title={val}
                                  onClick={() => {
                                    void navigator.clipboard?.writeText(val).then(() => notify('Copied cell'));
                                  }}
                                >
                                  {val}
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </div>
            }
          >
            <pre class="flex-1 min-h-0 m-0 p-3 overflow-auto bg-[var(--bg-code)] text-[12px] font-mono-num text-[var(--ink-primary)] leading-relaxed">
              <code>{formattedJsonText()}</code>
            </pre>
          </Show>
        </div>
      );
    }

    // markdown, mermaid, code
    return (
      <div class="flex-1 min-h-0 min-w-0 overflow-y-auto p-3.5 bg-[var(--bg-canvas)]">
        <div
          ref={markdownHostRef}
          class="omnia-prose min-w-0"
          onClick={(e) => handleRichMarkdownClick(e, { onNotify: notify })}
          innerHTML={previewMarkdownHtml()}
        />
      </div>
    );
  };

  const renderCodePane = () => {
    const lineCount = draft() ? draft().split(/\r?\n/).length : 1;
    return (
      <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-code)]">
        <div class="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-mono-num min-w-0">
          <span class="text-[var(--ink-muted)]">
            {lineCount} lines · {draft().length} chars {isDirty() ? '· modified' : ''}
          </span>
          <div class="flex items-center gap-1 shrink-0">
            <Show when={props.artifact?.kind === 'json'}>
              <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={handleFormatJson}>
                Format JSON
              </button>
            </Show>
            <Show when={isDirty()}>
              <button
                type="button"
                class="omnia-btn px-2 py-0.5 text-[10.5px]"
                title="Revert to selected version"
                onClick={() => {
                  const v = activeVersion();
                  if (v) setDraft(v.content);
                }}
              >
                <RotateCcw class="w-3 h-3" />
                <span>Revert</span>
              </button>
              <button
                type="button"
                class="omnia-btn omnia-btn-primary px-2 py-0.5 text-[10.5px]"
                title="Save as new version (Ctrl+S)"
                onClick={commitManualVersion}
              >
                <Save class="w-3 h-3" />
                <span>Save v{versions().length + 1}</span>
              </button>
            </Show>
          </div>
        </div>
        <textarea
          data-testid="canvas-code-editor"
          spellcheck={false}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              commitManualVersion();
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = `${draft().slice(0, start)}  ${draft().slice(end)}`;
              setDraft(next);
              requestAnimationFrame(() => {
                el.selectionStart = start + 2;
                el.selectionEnd = start + 2;
              });
            }
          }}
          class="flex-1 w-full min-h-[240px] p-3 bg-[var(--bg-code)] text-[var(--ink-primary)] font-mono-num text-[12px] leading-relaxed outline-none resize-none border-0"
        />
      </div>
    );
  };

  const renderDiffPane = () => {
    const diff = diffComputation();
    const list = versions();
    return (
      <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-code)]">
        <div class="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num min-w-0">
          <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span class="text-[var(--ink-muted)]">Compare</span>
            <select
              value={String(diffBaseIdx())}
              onChange={(e) => setDiffBaseIdx(Number(e.currentTarget.value))}
              class="bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-1.5 py-0.5 text-[11px] text-[var(--ink-primary)]"
            >
              <For each={list}>
                {(v, idx) => (
                  <option value={String(idx())}>
                    v{idx() + 1} · {v.label}
                  </option>
                )}
              </For>
            </select>
            <span class="text-[var(--ink-muted)]">-&gt;</span>
            <span class="text-[var(--accent-cyan)] font-semibold truncate">{diff.currLabel}</span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="omnia-badge text-[var(--status-emerald)]">+{diff.added}</span>
            <span class="omnia-badge text-[var(--status-coral)]">-{diff.removed}</span>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-auto p-2 font-mono-num text-[11.5px] leading-relaxed">
          <Show
            when={diff.added > 0 || diff.removed > 0}
            fallback={
              <div class="p-4 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[12px] text-[var(--ink-muted)]">
                No line differences between {diff.baseLabel} and {diff.currLabel}. Edit code or switch versions to inspect diffs.
              </div>
            }
          >
            <For each={diff.lines}>
              {(line) => (
                <div
                  class="flex items-start gap-2 px-2 py-0.5 whitespace-pre-wrap break-words"
                  classList={{
                    'bg-[var(--status-emerald-dim)] text-[var(--status-emerald)]': line.kind === 'add',
                    'bg-[var(--status-coral-dim)] text-[var(--status-coral)]': line.kind === 'del',
                    'text-[var(--ink-secondary)]': line.kind === 'same',
                  }}
                >
                  <span class="w-8 shrink-0 text-right text-[var(--ink-muted)] select-none">
                    {line.oldLine ?? ''}
                  </span>
                  <span class="w-8 shrink-0 text-right text-[var(--ink-muted)] select-none">
                    {line.newLine ?? ''}
                  </span>
                  <span class="w-3 shrink-0 font-bold select-none">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span class="flex-1 min-w-0">{line.text || ' '}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <Show when={props.open && props.artifact}>
      {(art) => (
        <aside
          data-testid="artifact-canvas-drawer"
          class="shrink-0 h-full border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col min-w-0 overflow-hidden"
          classList={{
            'w-[min(860px,78vw)] max-w-[96vw]': expanded(),
            'w-[min(640px,52vw)] min-w-[320px] max-w-[94vw]': !expanded(),
          }}
        >
          {/* Header */}
          <div class="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2 min-w-0">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <Show
                when={art().kind === 'csv' || art().kind === 'json'}
                fallback={<FileCode2 class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />}
              >
                <Table class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
              </Show>
              <span class="font-semibold text-[13px] text-[var(--ink-primary)] truncate min-w-0">
                {art().title || 'Untitled Artifact'}
              </span>
              <span class="omnia-badge text-[var(--accent-cyan)] shrink-0">{KIND_LABELS[art().kind]}</span>
              <Show when={art().language && art().kind === 'code'}>
                <span class="omnia-badge font-mono-num shrink-0">{art().language}</span>
              </Show>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                class="omnia-btn px-2 py-1 text-[11px]"
                title="Copy artifact content"
                onClick={() => void handleCopy()}
              >
                <Show when={copied()} fallback={<Copy class="w-3.5 h-3.5" />}>
                  <Check class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                </Show>
                <span>{copied() ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                class="omnia-btn px-2 py-1 text-[11px]"
                title="Download artifact file"
                onClick={handleDownload}
              >
                <Download class="w-3.5 h-3.5" />
                <span>Save</span>
              </button>
              <button
                type="button"
                class="omnia-btn px-1.5 py-1"
                title={expanded() ? 'Restore drawer width' : 'Expand canvas width'}
                onClick={() => setExpanded((v) => !v)}
              >
                <Show when={expanded()} fallback={<Maximize2 class="w-3.5 h-3.5" />}>
                  <Minimize2 class="w-3.5 h-3.5" />
                </Show>
              </button>
              <button
                type="button"
                class="omnia-btn px-1.5 py-1"
                title="Close canvas drawer"
                onClick={props.onClose}
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Tabs + Version Scrubber */}
          <div class="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center justify-between gap-2 min-w-0">
            <div class="omp-segmented flex-wrap">
              <button
                type="button"
                aria-pressed={activeTab() === 'preview'}
                onClick={() => setActiveTab('preview')}
                class="!px-2 !py-1 !text-[11px] inline-flex items-center gap-1"
              >
                <Eye class="w-3 h-3" />
                <span>Live Preview</span>
              </button>
              <button
                type="button"
                aria-pressed={activeTab() === 'code'}
                onClick={() => setActiveTab('code')}
                class="!px-2 !py-1 !text-[11px] inline-flex items-center gap-1"
              >
                <Code2 class="w-3 h-3" />
                <span>Editable Code</span>
              </button>
              <button
                type="button"
                aria-pressed={activeTab() === 'split'}
                onClick={() => setActiveTab('split')}
                class="!px-2 !py-1 !text-[11px] inline-flex items-center gap-1"
              >
                <Columns2 class="w-3 h-3" />
                <span>Split</span>
              </button>
              <button
                type="button"
                aria-pressed={activeTab() === 'diff'}
                onClick={() => setActiveTab('diff')}
                class="!px-2 !py-1 !text-[11px] inline-flex items-center gap-1"
              >
                <GitCompare class="w-3 h-3" />
                <span>Diff</span>
              </button>
            </div>

            {/* Version Scrubber */}
            <div class="flex items-center gap-1 min-w-0 overflow-x-auto">
              <History class="w-3.5 h-3.5 text-[var(--ink-muted)] shrink-0" />
              <button
                type="button"
                class="omnia-btn px-1 py-0.5 text-[10.5px]"
                disabled={selectedVersionIdx() <= 0}
                title="Previous version"
                onClick={() => selectVersion(selectedVersionIdx() - 1)}
              >
                <ChevronLeft class="w-3 h-3" />
              </button>
              <For each={versions()}>
                {(ver, idx) => (
                  <button
                    type="button"
                    title={`${ver.label} (${new Date(ver.ts).toLocaleTimeString()})`}
                    onClick={() => selectVersion(idx())}
                    class="px-1.5 py-0.5 rounded border text-[10.5px] font-mono-num shrink-0 cursor-pointer"
                    classList={{
                      'border-[var(--accent-cyan)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-semibold':
                        selectedVersionIdx() === idx(),
                      'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)]':
                        selectedVersionIdx() !== idx(),
                    }}
                  >
                    v{idx() + 1}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="omnia-btn px-1 py-0.5 text-[10.5px]"
                disabled={selectedVersionIdx() >= versions().length - 1}
                title="Next version"
                onClick={() => selectVersion(selectedVersionIdx() + 1)}
              >
                <ChevronRight class="w-3 h-3" />
              </button>
            </div>
          </div>

          <Show when={statusNote()}>
            <div class="px-3 py-1 border-b border-[var(--border-subtle)] bg-[var(--accent-dim)] text-[11px] font-mono-num text-[var(--accent-cyan)]">
              {statusNote()}
            </div>
          </Show>

          {/* Main Workspace */}
          <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
            <Show when={activeTab() === 'preview'}>{renderPreviewPane()}</Show>
            <Show when={activeTab() === 'code'}>{renderCodePane()}</Show>
            <Show when={activeTab() === 'split'}>
              <div class="flex-1 min-h-0 min-w-0 grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[var(--border-subtle)] overflow-hidden">
                <div class="min-h-0 min-w-0 flex flex-col overflow-hidden">{renderCodePane()}</div>
                <div class="min-h-0 min-w-0 flex flex-col overflow-hidden">{renderPreviewPane()}</div>
              </div>
            </Show>
            <Show when={activeTab() === 'diff'}>{renderDiffPane()}</Show>
          </div>

          {/* Inline "Refine in Omnia" Prompt Bar */}
          <div class="p-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-col gap-2 min-w-0">
            <div class="flex items-center gap-1 overflow-x-auto pb-0.5">
              <Sparkles class="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0" />
              <For each={REFINE_PRESETS}>
                {(preset) => (
                  <button
                    type="button"
                    onClick={() => handleRefineSubmit(preset.prompt)}
                    class="px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] hover:border-[var(--border-accent)] text-[10.5px] text-[var(--ink-secondary)] shrink-0 cursor-pointer"
                  >
                    {preset.label}
                  </button>
                )}
              </For>
            </div>
            <div class="flex items-center gap-1.5 min-w-0">
              <input
                data-testid="canvas-refine-input"
                type="text"
                value={refineInput()}
                onInput={(e) => setRefineInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleRefineSubmit();
                  }
                }}
                placeholder="Refine in Omnia (e.g., add dark mode toggle, optimize query, fix layout)..."
                class="flex-1 min-w-0 bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded px-2.5 py-1.5 text-[12px] text-[var(--ink-primary)] outline-none focus:border-[var(--border-accent)]"
              />
              <button
                type="button"
                data-testid="canvas-refine-submit"
                disabled={!refineInput().trim()}
                onClick={() => handleRefineSubmit()}
                class="omnia-btn omnia-btn-primary text-[11.5px] shrink-0"
              >
                <Send class="w-3.5 h-3.5" />
                <span>Refine</span>
              </button>
            </div>
          </div>
        </aside>
      )}
    </Show>
  );
}
