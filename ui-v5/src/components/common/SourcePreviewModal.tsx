import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { ArrowUpDown, Binary, Download, FileArchive, FileText, Folder, RotateCcw, Search, ShieldCheck, X, ZoomIn, ZoomOut } from 'lucide-solid';
import { flashNotice, privacyMask } from '@/state/studio';
import { sha256Hex } from '@/utils/crypto';
import { handleRichMarkdownClick, renderRichMarkdown } from '@/utils/markdown';
import { downloadTextFile, maskText } from '@/utils/privacy';
import { formatBytes } from '@/utils/stats';

export interface PreviewDocumentData {
  id?: string;
  name: string;
  kind?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  content?: string;
  mediaUrl?: string;
  sourceUrl?: string;
  rawBytes?: Uint8Array;
  base64Data?: string;
  sheets?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  cells?: Array<{
    cell_type: string;
    execution_count?: number | null;
    source: string | string[];
    outputs?: Array<Record<string, unknown>>;
  }>;
  entries?: Array<{ path: string; size?: number; dir?: boolean }>;
  hexDump?: string;
}

interface HexRow {
  offset: string;
  hexLeft: string;
  hexRight: string;
  ascii: string;
}

function detectKind(doc: PreviewDocumentData): string {
  const raw = (doc.kind || '').toLowerCase();
  const ext = (doc.name.includes('.') ? doc.name.split('.').pop() || '' : '').toLowerCase();
  const mime = (doc.mimeType || '').toLowerCase();
  if (raw === 'pdf' || ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (raw === 'image' || mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (raw === 'audio' || mime.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'].includes(ext)) return 'audio';
  if (raw === 'video' || mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (raw === 'spreadsheet' || Array.isArray(doc.sheets) || ['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'spreadsheet';
  if (raw === 'ipynb' || Array.isArray(doc.cells) || ext === 'ipynb') return 'ipynb';
  if (raw === 'archive' || Array.isArray(doc.entries) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'jar'].includes(ext)) return 'archive';
  if (raw === 'latex' || ['tex', 'bib'].includes(ext)) return 'latex';
  if (raw === 'markdown' || ['md', 'mdx', 'markdown'].includes(ext)) return 'markdown';
  if (raw === 'json' || ext === 'json') return 'json';
  if (raw === 'html' || ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
  if (raw === 'svg' || ext === 'svg' || mime === 'image/svg+xml') return 'svg';
  if (raw === 'binary' || doc.hexDump || doc.rawBytes || doc.base64Data || ['bin', 'exe', 'dll', 'wasm', 'so', 'dylib', 'db', 'sqlite', 'pdfbin'].includes(ext)) return 'binary';
  return 'code';
}

/**
 * Full RFC-4180 CSV/TSV parser supporting quoted commas, escaped "" quotes,
 * and embedded newlines inside quoted fields.
 */
export function parseRfc4180Rows(text: string, sep = ','): { headers: string[]; rows: string[][] } {
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!input.trim()) return { headers: [], rows: [] };

  const allRows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c.length > 0)) {
        allRows.push(row);
      }
      row = [];
      field = '';
      if (allRows.length >= 1001) break;
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c.length > 0)) {
      allRows.push(row);
    }
  }

  if (allRows.length === 0) return { headers: [], rows: [] };
  const headers = allRows[0].map((h, idx) => h || `Col ${idx + 1}`);
  const rows = allRows.slice(1, 1001).map((r) => {
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push('');
    return padded;
  });
  return { headers, rows };
}

function stripAnsiCodes(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function detectMagicSignature(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'Empty (0 B)';
  const hex = (n: number) =>
    Array.from(bytes.slice(0, Math.min(n, bytes.length)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const h16 = hex(16);
  const ascii16 = Array.from(bytes.slice(0, Math.min(16, bytes.length)))
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
    .join('');

  if (h16.startsWith('89504e470d0a1a0a')) return 'PNG Image (89 50 4E 47)';
  if (h16.startsWith('ffd8ff')) return 'JPEG Image (FF D8 FF)';
  if (h16.startsWith('47494638')) return 'GIF Image (GIF8)';
  if (ascii16.startsWith('%PDF-')) return 'PDF Document (%PDF-)';
  if (h16.startsWith('504b0304') || h16.startsWith('504b0506')) return 'ZIP / OOXML Archive (PK)';
  if (h16.startsWith('1f8b')) return 'GZIP Compressed (1F 8B)';
  if (h16.startsWith('377abcaf271c')) return '7-Zip Archive (37 7A BC AF)';
  if (h16.startsWith('526172211a07')) return 'RAR Archive (Rar!)';
  if (h16.startsWith('7f454c46')) return 'ELF Executable (7F ELF)';
  if (h16.startsWith('4d5a')) return 'PE / MZ Binary (4D 5A)';
  if (h16.startsWith('0061736d')) return 'WebAssembly (00 asm)';
  if (ascii16.startsWith('SQLite format 3')) return 'SQLite 3 Database';
  if (h16.startsWith('4f676753')) return 'Ogg Media (OggS)';
  if (ascii16.startsWith('RIFF') && ascii16.slice(8, 12) === 'WAVE') return 'WAV Audio (RIFF/WAVE)';
  if (ascii16.startsWith('RIFF') && ascii16.slice(8, 12) === 'WEBP') return 'WebP Image (RIFF/WEBP)';
  if (ascii16.slice(4, 8) === 'ftyp') return 'ISO-BMFF / MP4 (ftyp)';
  if (h16.startsWith('1a45dfa3')) return 'EBML / WebM / MKV';
  if (bytes.length >= 257) {
    const ustar = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(257, 262));
    if (ustar === 'ustar') return 'POSIX TAR Archive (ustar)';
  }
  const printable = bytes.slice(0, 64).filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)).length;
  if (printable / Math.min(bytes.length, 64) >= 0.85) return 'UTF-8 / ASCII Payload';
  return 'Raw Binary Stream';
}

function buildHexRowsFromBytes(bytes: Uint8Array, maxBytes = 4096): HexRow[] {
  const slice = bytes.slice(0, maxBytes);
  const rows: HexRow[] = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.slice(offset, offset + 16);
    const left: string[] = [];
    const right: string[] = [];
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const b = chunk[i];
        const hx = b.toString(16).padStart(2, '0').toUpperCase();
        if (i < 8) left.push(hx);
        else right.push(hx);
        ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
      } else {
        if (i < 8) left.push('  ');
        else right.push('  ');
        ascii += ' ';
      }
    }
    rows.push({
      offset: offset.toString(16).padStart(8, '0').toUpperCase(),
      hexLeft: left.join(' '),
      hexRight: right.join(' '),
      ascii,
    });
  }
  return rows;
}

function decodeDocBytes(doc: PreviewDocumentData): Uint8Array {
  if (doc.rawBytes && doc.rawBytes.length > 0) return doc.rawBytes;
  if (doc.base64Data) {
    try {
      const bin = atob(doc.base64Data.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      // fall through
    }
  }
  if (doc.hexDump) {
    const hexTokens: number[] = [];
    for (const line of doc.hexDump.split(/\r?\n/)) {
      const cleaned = line.replace(/^[0-9a-fA-F]{4,8}:?\s+/, '').split(/\s{2,}|\|/)[0] ?? '';
      const pairs = cleaned.match(/\b[0-9a-fA-F]{2}\b/g);
      if (pairs) {
        for (const p of pairs) hexTokens.push(Number.parseInt(p, 16));
      }
    }
    if (hexTokens.length > 0) return new Uint8Array(hexTokens);
  }
  if (doc.content) return new TextEncoder().encode(doc.content);
  return new Uint8Array();
}

function extractTextFromMimeVal(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map((x) => String(x)).join('');
  return '';
}

function convertTexToMd(tex: string): string {
  const body = tex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/)?.[1] ?? tex;
  return body
    .replace(/\\title\{([^{}]*)\}/g, '# $1\n')
    .replace(/\\section\*?\{([^{}]*)\}/g, '\n## $1\n')
    .replace(/\\subsection\*?\{([^{}]*)\}/g, '\n### $1\n')
    .replace(/\\textbf\{([^{}]*)\}/g, '**$1**')
    .replace(/\\textit\{([^{}]*)\}/g, '*$1*')
    .replace(/\\texttt\{([^{}]*)\}/g, '`$1`')
    .replace(/^\s*\\item\s+/gm, '- ');
}

export function SourcePreviewModal(props: {
  doc: PreviewDocumentData | null;
  onClose: () => void;
}) {
  const [subTab, setSubTab] = createSignal<'rendered' | 'raw' | 'frame'>('rendered');
  const [zoom, setZoom] = createSignal(1);
  const [playbackRate, setPlaybackRate] = createSignal(1);
  const [sheetIdx, setSheetIdx] = createSignal(0);
  const [filterText, setFilterText] = createSignal('');
  const [sortCol, setSortCol] = createSignal<number | null>(null);
  const [sortAsc, setSortAsc] = createSignal(true);
  const [archiveSort, setArchiveSort] = createSignal<'path' | 'size'>('path');
  const [computedSha, setComputedSha] = createSignal<string>('');

  let mediaElRef: HTMLMediaElement | undefined;

  const kind = createMemo(() => (props.doc ? detectKind(props.doc) : 'code'));

  createEffect(() => {
    const d = props.doc;
    setZoom(1);
    setPlaybackRate(1);
    setSheetIdx(0);
    setFilterText('');
    setSortCol(null);
    setSortAsc(true);
    setArchiveSort('path');
    setSubTab(d && detectKind(d) === 'pdf' && d.mediaUrl ? 'frame' : 'rendered');
    setComputedSha(d?.sha256 || '');
    if (d && !d.sha256) {
      const bytes = decodeDocBytes(d);
      if (bytes.length > 0 && bytes.length <= 2 * 1024 * 1024) {
        void sha256Hex(bytes).then((hex) => setComputedSha(hex));
      }
    }
  });

  createEffect(() => {
    const rate = playbackRate();
    if (mediaElRef) mediaElRef.playbackRate = rate;
  });

  onCleanup(() => {
    if (mediaElRef) {
      mediaElRef.pause();
      mediaElRef.removeAttribute('src');
    }
  });

  const sheets = createMemo(() => {
    const d = props.doc;
    if (!d) return [];
    if (Array.isArray(d.sheets) && d.sheets.length > 0) return d.sheets;
    const raw = d.content ?? '';
    const lowerName = d.name.toLowerCase();
    const sep = lowerName.endsWith('.tsv')
      ? '\t'
      : raw.includes('\t') && !raw.split('\n')[0]?.includes(',')
        ? '\t'
        : ',';
    const parsed = parseRfc4180Rows(raw, sep);
    return [{ name: 'Sheet 1', headers: parsed.headers, rows: parsed.rows }];
  });

  const activeSheet = createMemo(() => sheets()[sheetIdx()] ?? { name: 'Sheet 1', headers: [], rows: [] });

  const filteredSortedRows = createMemo(() => {
    const q = filterText().trim().toLowerCase();
    let list = activeSheet().rows;
    if (q) {
      list = list.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)));
    }
    const col = sortCol();
    if (col !== null) {
      const asc = sortAsc();
      list = [...list].sort((a, b) => {
        const av = (a[col] ?? '').trim();
        const bv = (b[col] ?? '').trim();
        const an = Number(av.replace(/,/g, ''));
        const bn = Number(bv.replace(/,/g, ''));
        if (av !== '' && bv !== '' && Number.isFinite(an) && Number.isFinite(bn)) {
          return asc ? an - bn : bn - an;
        }
        return asc ? av.localeCompare(bv, 'vi') : bv.localeCompare(av, 'vi');
      });
    }
    return list;
  });

  const archiveEntries = createMemo(() => {
    const d = props.doc;
    if (!d) return [];
    const q = filterText().trim().toLowerCase();
    let list: Array<{ path: string; size?: number; dir?: boolean }> = Array.isArray(d.entries) ? d.entries : [];
    if (list.length === 0 && d.content) {
      list = d.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => {
          const m = line.match(/^([^\t|]+?)(?:\s+[|\t]\s+(\d+))?$/);
          const p = (m?.[1] || line).replace(/^[-*]\s+/, '').trim();
          const sz = m?.[2] ? Number(m[2]) : undefined;
          return { path: p, size: sz, dir: p.endsWith('/') };
        });
    }
    if (q) {
      list = list.filter((e) => e.path.toLowerCase().includes(q));
    }
    if (archiveSort() === 'size') {
      return [...list].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
    }
    return [...list].sort((a, b) => a.path.localeCompare(b.path));
  });

  const archiveSummary = createMemo(() => {
    const all = archiveEntries();
    let dirs = 0;
    let files = 0;
    let totalBytes = 0;
    for (const e of all) {
      if (e.dir || e.path.endsWith('/')) dirs += 1;
      else {
        files += 1;
        totalBytes += e.size ?? 0;
      }
    }
    return { dirs, files, totalBytes };
  });

  const binaryInfo = createMemo(() => {
    const d = props.doc;
    if (!d) return { bytes: new Uint8Array(), rows: [] as HexRow[], magic: 'Empty' };
    const bytes = decodeDocBytes(d);
    return {
      bytes,
      rows: buildHexRowsFromBytes(bytes, 4096),
      magic: detectMagicSignature(bytes),
    };
  });

  const ipynbCells = createMemo(() => {
    const d = props.doc;
    if (!d) return [];
    if (Array.isArray(d.cells)) return d.cells;
    try {
      const parsed = JSON.parse(d.content ?? '{}') as { cells?: PreviewDocumentData['cells'] };
      return Array.isArray(parsed.cells) ? parsed.cells : [];
    } catch {
      return [];
    }
  });

  const handleClose = () => {
    if (mediaElRef) {
      mediaElRef.pause();
      mediaElRef.removeAttribute('src');
      mediaElRef.load();
    }
    props.onClose();
  };

  return (
    <Show when={props.doc}>
      {(doc) => (
        <div
          data-testid="source-preview-modal"
          class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={handleClose}
        >
          <div
            class="w-full max-w-4xl max-h-[88vh] rounded-lg border border-[var(--border-strong)] bg-[var(--bg-panel)] shadow-[var(--shadow-md)] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header Toolbar */}
            <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <FileText class="w-4 h-4 text-[var(--accent-cyan)] shrink-0" />
                <span class="font-bold text-[13px] truncate">{maskText(doc().name, privacyMask())}</span>
                <span class="omnia-badge font-mono-num uppercase text-[var(--accent-cyan)]">{kind()}</span>
                <Show when={doc().sizeBytes}>
                  <span class="omnia-badge font-mono-num">{formatBytes(doc().sizeBytes!)}</span>
                </Show>
                <Show when={computedSha() || doc().sha256}>
                  <span class="omnia-badge font-mono-num text-[var(--status-emerald)]">
                    sha256:{(computedSha() || doc().sha256 || '').slice(0, 12)}
                  </span>
                </Show>
              </div>
              <div class="flex items-center gap-1.5">
                <Show when={doc().content}>
                  <button
                    type="button"
                    class="omnia-btn text-[11px]"
                    onClick={() => {
                      downloadTextFile(doc().name, maskText(doc().content ?? '', privacyMask()));
                      flashNotice(`Downloaded ${doc().name}`);
                    }}
                  >
                    <Download class="w-3.5 h-3.5" />
                    <span>Save</span>
                  </button>
                </Show>
                <button type="button" class="omnia-btn px-2 py-1" onClick={handleClose} aria-label="Close Preview">
                  <X class="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 bg-[var(--bg-canvas)]">
              {/* PDF */}
              <Show when={kind() === 'pdf'}>
                <div class="omp-segmented text-[11px]">
                  <Show when={doc().mediaUrl}>
                    <button type="button" aria-pressed={subTab() === 'frame'} onClick={() => setSubTab('frame')}>
                      PDF Viewer
                    </button>
                  </Show>
                  <button type="button" aria-pressed={subTab() === 'rendered'} onClick={() => setSubTab('rendered')}>
                    Extracted Text
                  </button>
                </div>
                <Show when={subTab() === 'frame' && doc().mediaUrl}>
                  <iframe
                    src={doc().mediaUrl}
                    title={doc().name}
                    class="w-full h-[65vh] rounded border border-[var(--border-subtle)] bg-white"
                  />
                </Show>
                <Show when={subTab() !== 'frame' || !doc().mediaUrl}>
                  <div
                    class="omnia-prose p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
                    innerHTML={renderRichMarkdown(maskText(doc().content ?? 'No extracted PDF text available.', privacyMask()))}
                  />
                </Show>
              </Show>

              {/* Image Zoom */}
              <Show when={kind() === 'image'}>
                <div class="flex items-center gap-1.5">
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
                    <ZoomOut class="w-3.5 h-3.5" />
                  </button>
                  <span class="font-mono-num text-[11.5px] px-2">{Math.round(zoom() * 100)}%</span>
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
                    <ZoomIn class="w-3.5 h-3.5" />
                  </button>
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => setZoom(1)}>
                    <RotateCcw class="w-3.5 h-3.5" />
                    <span>100%</span>
                  </button>
                </div>
                <Show
                  when={doc().mediaUrl}
                  fallback={<div class="text-[12px] text-[var(--ink-muted)]">No inline image URL available.</div>}
                >
                  <div class="overflow-auto max-h-[64vh] rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-3 flex justify-center">
                    <img
                      src={doc().mediaUrl}
                      alt={doc().name}
                      style={{ transform: `scale(${zoom()})`, 'transform-origin': 'top center' }}
                      class="max-w-full rounded"
                    />
                  </div>
                </Show>
              </Show>

              {/* Audio / Video with 1x..2x speed pills */}
              <Show when={kind() === 'audio' || kind() === 'video'}>
                <div class="flex items-center gap-1.5 text-[11px] font-mono-num">
                  <span class="text-[var(--ink-muted)]">Speed:</span>
                  {[1, 1.25, 1.5, 2].map((r) => (
                    <button
                      type="button"
                      class="omnia-btn px-2 py-0.5 text-[11px]"
                      classList={{ 'border-[var(--border-accent)] text-[var(--accent-cyan)]': playbackRate() === r }}
                      onClick={() => setPlaybackRate(r)}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
                <Show when={doc().mediaUrl}>
                  <Show
                    when={kind() === 'video'}
                    fallback={
                      <audio
                        ref={(el) => {
                          mediaElRef = el;
                        }}
                        controls
                        preload="metadata"
                        src={doc().mediaUrl}
                        class="w-full"
                      />
                    }
                  >
                    <video
                      ref={(el) => {
                        mediaElRef = el;
                      }}
                      controls
                      preload="metadata"
                      src={doc().mediaUrl}
                      class="w-full max-h-[60vh] rounded border border-[var(--border-subtle)]"
                    />
                  </Show>
                </Show>
                <Show when={doc().content}>
                  <div
                    class="omnia-prose p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
                    innerHTML={renderRichMarkdown(maskText(doc().content ?? '', privacyMask()))}
                  />
                </Show>
              </Show>

              {/* Spreadsheet (RFC-4180 multi-sheet, live search, numeric/locale column sort) */}
              <Show when={kind() === 'spreadsheet'}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <div class="omp-segmented text-[11px]">
                      <For each={sheets()}>
                        {(sh, i) => (
                          <button type="button" aria-pressed={sheetIdx() === i()} onClick={() => setSheetIdx(i())}>
                            {sh.name}
                          </button>
                        )}
                      </For>
                    </div>
                    <span class="omnia-badge font-mono-num text-[10.5px]">
                      {filteredSortedRows().length}/{activeSheet().rows.length} rows · {activeSheet().headers.length} cols
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1">
                    <Search class="w-3.5 h-3.5 text-[var(--ink-muted)]" />
                    <input
                      type="text"
                      placeholder="Filter rows..."
                      value={filterText()}
                      onInput={(e) => setFilterText(e.currentTarget.value)}
                      class="bg-transparent text-[11.5px] outline-none w-44"
                    />
                  </div>
                </div>
                <div class="overflow-auto max-h-[60vh] rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)]">
                  <table class="w-full text-left border-collapse text-[11.5px] font-mono-num">
                    <thead>
                      <tr class="border-b border-[var(--border-subtle)] bg-[var(--bg-rail)]">
                        <th class="px-2 py-1.5 text-[var(--ink-muted)]">#</th>
                        <For each={activeSheet().headers}>
                          {(h, ci) => (
                            <th class="px-2.5 py-1.5">
                              <button
                                type="button"
                                class="inline-flex items-center gap-1 font-semibold text-[var(--ink-primary)] cursor-pointer"
                                onClick={() => {
                                  if (sortCol() === ci()) setSortAsc(!sortAsc());
                                  else {
                                    setSortCol(ci());
                                    setSortAsc(true);
                                  }
                                }}
                              >
                                <span>{h}</span>
                                <Show
                                  when={sortCol() === ci()}
                                  fallback={<ArrowUpDown class="w-3 h-3 text-[var(--ink-muted)]" />}
                                >
                                  <span class="text-[var(--accent-cyan)] text-[10px]">{sortAsc() ? '↑' : '↓'}</span>
                                </Show>
                              </button>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-[var(--border-subtle)]">
                      <For each={filteredSortedRows()}>
                        {(row, ri) => (
                          <tr>
                            <td class="px-2 py-1 text-[var(--ink-muted)]">{ri() + 1}</td>
                            <For each={activeSheet().headers}>
                              {(_h, ci) => <td class="px-2.5 py-1 whitespace-pre-wrap">{maskText(row[ci()] ?? '', privacyMask())}</td>}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>

              {/* Jupyter .ipynb (cells + full cell.outputs + inline base64 images) */}
              <Show when={kind() === 'ipynb'}>
                <div class="space-y-2.5">
                  <div class="text-[11px] font-mono-num text-[var(--ink-muted)]">
                    Jupyter Notebook · {ipynbCells().length} cells
                  </div>
                  <For each={ipynbCells()}>
                    {(cell, idx) => {
                      const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
                      const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
                      const execNum = typeof cell.execution_count === 'number' ? cell.execution_count : idx() + 1;
                      return (
                        <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2">
                          <div class="flex items-center justify-between text-[10.5px] font-mono-num text-[var(--accent-cyan)]">
                            <span>
                              {cell.cell_type === 'markdown'
                                ? `Markdown [${idx() + 1}]`
                                : cell.cell_type === 'raw'
                                  ? `Raw [${idx() + 1}]`
                                  : `In [${execNum}]`}
                            </span>
                            <Show when={outputs.length > 0}>
                              <span class="text-[var(--ink-muted)]">{outputs.length} output(s)</span>
                            </Show>
                          </div>
                          <div
                            class="omnia-prose text-[12.5px]"
                            onClick={(e) => handleRichMarkdownClick(e, { onNotify: flashNotice })}
                            innerHTML={renderRichMarkdown(
                              cell.cell_type === 'markdown'
                                ? maskText(src, privacyMask())
                                : `\`\`\`${cell.cell_type === 'raw' ? 'text' : 'python'}\n${maskText(src, privacyMask())}\n\`\`\``,
                            )}
                          />
                          <Show when={outputs.length > 0}>
                            <div class="pt-2 border-t border-[var(--border-subtle)] space-y-2">
                              <For each={outputs}>
                                {(out) => {
                                  const outType = String(out.output_type ?? '');
                                  const dataObj =
                                    out.data && typeof out.data === 'object'
                                      ? (out.data as Record<string, unknown>)
                                      : null;
                                  const pngB64 = dataObj ? extractTextFromMimeVal(dataObj['image/png']).replace(/\s+/g, '') : '';
                                  const jpgB64 = dataObj ? extractTextFromMimeVal(dataObj['image/jpeg']).replace(/\s+/g, '') : '';
                                  const webpB64 = dataObj ? extractTextFromMimeVal(dataObj['image/webp']).replace(/\s+/g, '') : '';
                                  const htmlVal = dataObj ? extractTextFromMimeVal(dataObj['text/html']) : '';
                                  const mdVal = dataObj ? extractTextFromMimeVal(dataObj['text/markdown']) : '';
                                  const plainVal = dataObj
                                    ? extractTextFromMimeVal(dataObj['text/plain'])
                                    : extractTextFromMimeVal(out.text);
                                  const errTrace = Array.isArray(out.traceback)
                                    ? out.traceback.map((t) => stripAnsiCodes(String(t))).join('\n')
                                    : '';

                                  return (
                                    <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] p-2.5 text-[11.5px] space-y-1.5">
                                      <div class="text-[10px] font-mono-num uppercase text-[var(--ink-muted)]">
                                        {outType === 'stream' ? `stream:${String(out.name ?? 'stdout')}` : outType || 'output'}
                                      </div>
                                      <Show when={pngB64}>
                                        <img
                                          src={`data:image/png;base64,${pngB64}`}
                                          alt="Notebook cell PNG output"
                                          class="max-w-full rounded border border-[var(--border-subtle)] bg-white"
                                        />
                                      </Show>
                                      <Show when={!pngB64 && jpgB64}>
                                        <img
                                          src={`data:image/jpeg;base64,${jpgB64}`}
                                          alt="Notebook cell JPEG output"
                                          class="max-w-full rounded border border-[var(--border-subtle)]"
                                        />
                                      </Show>
                                      <Show when={!pngB64 && !jpgB64 && webpB64}>
                                        <img
                                          src={`data:image/webp;base64,${webpB64}`}
                                          alt="Notebook cell WebP output"
                                          class="max-w-full rounded border border-[var(--border-subtle)]"
                                        />
                                      </Show>
                                      <Show when={htmlVal}>
                                        <iframe
                                          sandbox=""
                                          title="Notebook HTML Output"
                                          srcdoc={htmlVal}
                                          class="w-full h-44 rounded border border-[var(--border-subtle)] bg-white"
                                        />
                                      </Show>
                                      <Show when={!htmlVal && mdVal}>
                                        <div
                                          class="omnia-prose text-[12px]"
                                          innerHTML={renderRichMarkdown(maskText(mdVal, privacyMask()))}
                                        />
                                      </Show>
                                      <Show when={outType === 'error'}>
                                        <pre class="m-0 text-[11px] font-mono-num text-[var(--status-coral)] overflow-x-auto whitespace-pre-wrap">
                                          {`${String(out.ename ?? 'Error')}: ${String(out.evalue ?? '')}${errTrace ? `\n${errTrace}` : ''}`}
                                        </pre>
                                      </Show>
                                      <Show when={plainVal && !pngB64 && !jpgB64 && !webpB64 && !htmlVal && !mdVal && outType !== 'error'}>
                                        <pre
                                          class="m-0 text-[11px] font-mono-num overflow-x-auto whitespace-pre-wrap"
                                          classList={{
                                            'text-[var(--status-coral)]': outType === 'stream' && out.name === 'stderr',
                                            'text-[var(--ink-secondary)]': !(outType === 'stream' && out.name === 'stderr'),
                                          }}
                                        >
                                          {maskText(stripAnsiCodes(plainVal), privacyMask())}
                                        </pre>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* Archive tree inspector (.zip / .tar / .gz / .7z) */}
              <Show when={kind() === 'archive'}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex flex-wrap items-center gap-1.5 text-[11px] font-mono-num">
                    <span class="omnia-badge text-[var(--accent-cyan)]">
                      <FileArchive class="w-3 h-3" />
                      <span>{archiveSummary().files} files · {archiveSummary().dirs} dirs</span>
                    </span>
                    <Show when={archiveSummary().totalBytes > 0}>
                      <span class="omnia-badge">{formatBytes(archiveSummary().totalBytes)} uncompressed</span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <div class="omp-segmented text-[10.5px]">
                      <button type="button" aria-pressed={archiveSort() === 'path'} onClick={() => setArchiveSort('path')}>
                        Tree Order
                      </button>
                      <button type="button" aria-pressed={archiveSort() === 'size'} onClick={() => setArchiveSort('size')}>
                        Largest
                      </button>
                    </div>
                    <div class="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 w-52">
                      <Search class="w-3.5 h-3.5 text-[var(--ink-muted)]" />
                      <input
                        type="text"
                        placeholder="Filter archive tree..."
                        value={filterText()}
                        onInput={(e) => setFilterText(e.currentTarget.value)}
                        class="bg-transparent text-[11.5px] outline-none flex-1"
                      />
                    </div>
                  </div>
                </div>
                <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] max-h-[58vh] overflow-y-auto divide-y divide-[var(--border-subtle)] text-[11.5px] font-mono-num">
                  <For each={archiveEntries()}>
                    {(ent) => {
                      const cleanPath = ent.path.replace(/\/$/, '');
                      const depth = Math.max(0, cleanPath.split('/').length - 1);
                      const isDir = Boolean(ent.dir || ent.path.endsWith('/'));
                      return (
                        <div
                          class="px-3 py-1.5 flex items-center justify-between gap-2"
                          style={{ 'padding-left': `${12 + Math.min(depth, 6) * 14}px` }}
                        >
                          <span class="flex items-center gap-1.5 min-w-0 truncate">
                            <Show
                              when={isDir}
                              fallback={<FileText class="w-3 h-3 text-[var(--ink-muted)] shrink-0" />}
                            >
                              <Folder class="w-3 h-3 text-[var(--accent-amber)] shrink-0" />
                            </Show>
                            <span class="truncate" classList={{ 'text-[var(--accent-amber)] font-semibold': isDir }}>
                              {maskText(ent.path, privacyMask())}
                            </span>
                          </span>
                          <span class="text-[var(--ink-muted)] shrink-0">
                            {isDir ? 'DIR' : formatBytes(ent.size ?? 0)}
                          </span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* 16-Byte Binary Hex Dump Table (Offset · Hex · ASCII · Magic · SHA-256) */}
              <Show when={kind() === 'binary'}>
                <div class="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
                  <span class="omnia-badge text-[var(--accent-cyan)]">
                    <Binary class="w-3 h-3" />
                    <span>Magic: {binaryInfo().magic}</span>
                  </span>
                  <span class="omnia-badge">
                    {formatBytes(doc().sizeBytes ?? binaryInfo().bytes.length)} ({binaryInfo().bytes.length} B inspected)
                  </span>
                  <Show when={computedSha()}>
                    <span class="omnia-badge text-[var(--status-emerald)]">
                      <ShieldCheck class="w-3 h-3" />
                      <span>SHA-256: {computedSha().slice(0, 16)}…</span>
                    </span>
                  </Show>
                </div>
                <Show
                  when={binaryInfo().rows.length > 0}
                  fallback={
                    <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num overflow-auto max-h-[60vh]">
                      {doc().hexDump || doc().content || 'No binary bytes available.'}
                    </pre>
                  }
                >
                  <div class="overflow-auto max-h-[58vh] rounded border border-[var(--border-subtle)] bg-[var(--bg-code)]">
                    <table class="w-full border-collapse text-[11px] font-mono-num">
                      <thead>
                        <tr class="border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] text-[var(--ink-muted)]">
                          <th class="px-2.5 py-1.5 text-left w-24">Offset</th>
                          <th class="px-2.5 py-1.5 text-left">00 01 02 03 04 05 06 07</th>
                          <th class="px-2.5 py-1.5 text-left">08 09 0A 0B 0C 0D 0E 0F</th>
                          <th class="px-2.5 py-1.5 text-left border-l border-[var(--border-subtle)]">ASCII</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-[var(--border-subtle)]">
                        <For each={binaryInfo().rows}>
                          {(row) => (
                            <tr>
                              <td class="px-2.5 py-0.5 text-[var(--accent-amber)] select-none">{row.offset}</td>
                              <td class="px-2.5 py-0.5 text-[var(--ink-primary)] whitespace-pre">{row.hexLeft}</td>
                              <td class="px-2.5 py-0.5 text-[var(--ink-secondary)] whitespace-pre">{row.hexRight}</td>
                              <td class="px-2.5 py-0.5 text-[var(--accent-cyan)] whitespace-pre border-l border-[var(--border-subtle)]">
                                {row.ascii}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </Show>

              {/* HTML / SVG Sandboxed Preview */}
              <Show when={kind() === 'html' || kind() === 'svg'}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="omp-segmented text-[11px]">
                    <button type="button" aria-pressed={subTab() === 'rendered'} onClick={() => setSubTab('rendered')}>
                      Sandboxed Preview
                    </button>
                    <button type="button" aria-pressed={subTab() === 'raw'} onClick={() => setSubTab('raw')}>
                      Raw Source
                    </button>
                  </div>
                  <span class="omnia-badge text-[10.5px] font-mono-num text-[var(--status-emerald)]">
                    sandbox="" · scripts disabled
                  </span>
                </div>
                <Show
                  when={subTab() === 'rendered'}
                  fallback={
                    <div
                      class="omnia-prose p-3.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
                      onClick={(e) => handleRichMarkdownClick(e, { onNotify: flashNotice })}
                      innerHTML={renderRichMarkdown(`\`\`\`${kind()}\n${maskText(doc().content ?? '', privacyMask())}\n\`\`\``)}
                    />
                  }
                >
                  <iframe
                    sandbox=""
                    title={doc().name}
                    srcdoc={doc().content ?? ''}
                    class="w-full h-[60vh] rounded border border-[var(--border-subtle)] bg-white"
                  />
                </Show>
              </Show>

              {/* Markdown / LaTeX / JSON / Code */}
              <Show when={['markdown', 'latex', 'json', 'code'].includes(kind())}>
                <Show when={kind() === 'markdown' || kind() === 'latex'}>
                  <div class="omp-segmented text-[11px]">
                    <button type="button" aria-pressed={subTab() === 'rendered'} onClick={() => setSubTab('rendered')}>
                      Rendered
                    </button>
                    <button type="button" aria-pressed={subTab() === 'raw'} onClick={() => setSubTab('raw')}>
                      Raw Source
                    </button>
                  </div>
                </Show>
                <div
                  class="omnia-prose p-3.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
                  onClick={(e) => handleRichMarkdownClick(e, { onNotify: flashNotice })}
                  innerHTML={renderRichMarkdown(
                    subTab() === 'raw' || kind() === 'code' || kind() === 'json'
                      ? `\`\`\`${kind() === 'json' ? 'json' : kind() === 'latex' ? 'latex' : doc().name.split('.').pop() || 'text'}\n${maskText(doc().content ?? '', privacyMask())}\n\`\`\``
                      : kind() === 'latex'
                        ? convertTexToMd(maskText(doc().content ?? '', privacyMask()))
                        : maskText(doc().content ?? '', privacyMask()),
                  )}
                />
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
