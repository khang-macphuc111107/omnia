import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { ArrowUpDown, Download, FileText, RotateCcw, Search, X, ZoomIn, ZoomOut } from 'lucide-solid';
import { flashNotice, privacyMask } from '@/state/studio';
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
  sheets?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  cells?: Array<{ cell_type: string; source: string | string[]; outputs?: Array<Record<string, unknown>> }>;
  entries?: Array<{ path: string; size?: number; dir?: boolean }>;
  hexDump?: string;
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
  if (raw === 'archive' || Array.isArray(doc.entries) || ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archive';
  if (raw === 'latex' || ['tex', 'bib'].includes(ext)) return 'latex';
  if (raw === 'markdown' || ['md', 'mdx', 'markdown'].includes(ext)) return 'markdown';
  if (raw === 'json' || ext === 'json') return 'json';
  if (raw === 'binary' || doc.hexDump) return 'binary';
  return 'code';
}

function parseCsvRows(text: string, sep = ','): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line: string) => line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  return {
    headers: splitLine(lines[0]),
    rows: lines.slice(1, 501).map(splitLine),
  };
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
    setSubTab(d && detectKind(d) === 'pdf' && d.mediaUrl ? 'frame' : 'rendered');
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
    const sep = d.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const parsed = parseCsvRows(d.content ?? '', sep);
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
    const q = filterText().trim().toLowerCase();
    const list = props.doc?.entries ?? [];
    if (!q) return list;
    return list.filter((e) => e.path.toLowerCase().includes(q));
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
                <Show when={doc().sha256}>
                  <span class="omnia-badge font-mono-num text-[var(--status-emerald)]">
                    sha256:{doc().sha256!.slice(0, 10)}
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

              {/* Spreadsheet (multi-sheet, live search, column sort) */}
              <Show when={kind() === 'spreadsheet'}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="omp-segmented text-[11px]">
                    <For each={sheets()}>
                      {(sh, i) => (
                        <button type="button" aria-pressed={sheetIdx() === i()} onClick={() => setSheetIdx(i())}>
                          {sh.name}
                        </button>
                      )}
                    </For>
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
                                <ArrowUpDown class="w-3 h-3 text-[var(--ink-muted)]" />
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
                              {(_h, ci) => <td class="px-2.5 py-1">{maskText(row[ci()] ?? '', privacyMask())}</td>}
                            </For>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>

              {/* Jupyter .ipynb */}
              <Show when={kind() === 'ipynb'}>
                <div class="space-y-2.5">
                  <For each={ipynbCells()}>
                    {(cell, idx) => {
                      const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
                      return (
                        <div class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2">
                          <div class="text-[10.5px] font-mono-num text-[var(--accent-cyan)]">
                            {cell.cell_type === 'markdown' ? `Markdown [${idx() + 1}]` : `In [${idx() + 1}]`}
                          </div>
                          <div
                            class="omnia-prose text-[12.5px]"
                            innerHTML={renderRichMarkdown(
                              cell.cell_type === 'markdown' ? src : `\`\`\`python\n${src}\n\`\`\``,
                            )}
                          />
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>

              {/* Archive tree */}
              <Show when={kind() === 'archive'}>
                <div class="flex items-center gap-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-2 py-1 w-64">
                  <Search class="w-3.5 h-3.5 text-[var(--ink-muted)]" />
                  <input
                    type="text"
                    placeholder="Filter archive entries..."
                    value={filterText()}
                    onInput={(e) => setFilterText(e.currentTarget.value)}
                    class="bg-transparent text-[11.5px] outline-none flex-1"
                  />
                </div>
                <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] max-h-[58vh] overflow-y-auto divide-y divide-[var(--border-subtle)] text-[11.5px] font-mono-num">
                  <For each={archiveEntries()}>
                    {(ent) => (
                      <div class="px-3 py-1.5 flex justify-between gap-2">
                        <span class="truncate">{maskText(ent.path, privacyMask())}</span>
                        <span class="text-[var(--ink-muted)] shrink-0">
                          {ent.dir ? 'DIR' : formatBytes(ent.size ?? 0)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Binary Hex + ASCII */}
              <Show when={kind() === 'binary'}>
                <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11.5px] font-mono-num overflow-auto max-h-[64vh]">
                  {doc().hexDump || doc().content || 'No binary hex preview available.'}
                </pre>
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
