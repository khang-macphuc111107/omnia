import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import 'katex/contrib/mhchem';
import type { ComposerTemplate } from '@/types';

const markedInstance = new Marked({
  breaks: true,
  gfm: true,
});

const EXT_FOR_LANG: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  python: 'py',
  py: 'py',
  rust: 'rs',
  rs: 'rs',
  cpp: 'cpp',
  c: 'c',
  csharp: 'cs',
  java: 'java',
  go: 'go',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  html: 'html',
  xml: 'xml',
  svg: 'svg',
  css: 'css',
  markdown: 'md',
  md: 'md',
  latex: 'tex',
  tex: 'tex',
  mermaid: 'mmd',
};

const ALERT_LABELS: Record<string, { label: string; cls: string }> = {
  NOTE: { label: 'NOTE', cls: 'note' },
  TIP: { label: 'TIP', cls: 'tip' },
  IMPORTANT: { label: 'IMPORTANT', cls: 'important' },
  WARNING: { label: 'WARNING', cls: 'warning' },
  CAUTION: { label: 'CAUTION', cls: 'caution' },
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeSvgMarkup(rawSvg: string): string {
  const str = String(rawSvg || '').trim();
  if (!/<svg[\s>]/i.test(str)) return '';
  return str
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(?:href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

function renderLatexSegment(expr: string, displayMode: boolean): string {
  const clean = expr.trim();
  try {
    return katex.renderToString(clean, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return `<code class="omnia-math-fallback">${escapeHtml(clean)}</code>`;
  }
}

function renderDisplayMathCard(expr: string): string {
  const clean = expr.trim();
  const rendered = renderLatexSegment(clean, true);
  const encodedTex = encodeURIComponent(clean);
  return (
    `<div class="omnia-math-card my-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-code)] px-3 py-2 relative">` +
    `<button type="button" class="omnia-math-copy-btn" data-copy-tex="${encodedTex}" title="Copy LaTeX source">TeX</button>` +
    `<div class="overflow-x-auto py-1">${rendered}</div>` +
    `</div>`
  );
}

function buildCodeCardHtml(text: string, rawLang = ''): string {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const cleanLang = (rawLang || 'text').trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, '') || 'text';
  const lineCount = normalized ? normalized.split('\n').length : 1;
  const ext = EXT_FOR_LANG[cleanLang] || 'txt';
  const encodedRaw = encodeURIComponent(normalized);

  if (cleanLang === 'mermaid') {
    return (
      `<div class="omnia-code-card rounded-md border border-[var(--border-subtle)] bg-[var(--bg-code)] my-2 overflow-hidden" data-code-raw="${encodedRaw}" data-code-ext="mmd">` +
      `<div class="omnia-code-header">` +
      `<div class="flex items-center gap-2"><span class="font-semibold text-[var(--accent-cyan)]">mermaid</span><span>${lineCount} lines</span>` +
      `<button type="button" class="omnia-code-tab active" data-code-tab="preview">Diagram</button>` +
      `<button type="button" class="omnia-code-tab" data-code-tab="code">Source</button></div>` +
      `<div class="flex items-center gap-1">` +
      `<button type="button" class="omnia-code-btn" data-code-action="copy">Copy</button>` +
      `<button type="button" class="omnia-code-btn" data-code-action="download">Save</button>` +
      `</div></div>` +
      `<div data-code-pane="preview" class="omnia-mermaid p-3 overflow-x-auto" data-mermaid="${encodedRaw}"><pre class="text-xs text-[var(--ink-muted)] m-0 border-0">${escapeHtml(normalized)}</pre></div>` +
      `<pre data-code-pane="code" hidden class="hljs m-0 border-0 rounded-none"><code>${escapeHtml(normalized)}</code></pre>` +
      `</div>`
    );
  }

  let highlighted = escapeHtml(normalized);
  try {
    if (cleanLang !== 'text' && hljs.getLanguage(cleanLang)) {
      highlighted = hljs.highlight(normalized, { language: cleanLang, ignoreIllegals: true }).value;
    } else if (normalized.length <= 16000 && cleanLang === 'text') {
      highlighted = hljs.highlightAuto(normalized).value;
    }
  } catch {
    // keep escaped fallback
  }

  const linesHtml = highlighted
    .split('\n')
    .map((lineHtml, idx) => `<span class="omnia-code-line" data-line="${idx + 1}">${lineHtml || ' '}</span>`)
    .join('\n');

  const previewable = cleanLang === 'svg' || cleanLang === 'html';
  const showLinesDefault = lineCount >= 6;
  let previewHtml = '';
  if (cleanLang === 'svg') {
    const cleanSvg = sanitizeSvgMarkup(normalized);
    previewHtml = cleanSvg
      ? `<div class="p-3 bg-[var(--bg-canvas)] overflow-auto flex justify-center">${cleanSvg}</div>`
      : `<div class="p-3 text-xs text-[var(--ink-muted)]">Invalid SVG markup.</div>`;
  } else if (cleanLang === 'html') {
    previewHtml = `<iframe class="w-full h-64 bg-white border-0" sandbox="" title="Sandboxed HTML Preview" srcdoc="${escapeHtml(normalized)}"></iframe>`;
  }

  return (
    `<div class="omnia-code-card${showLinesDefault ? ' show-lines' : ''} rounded-md border border-[var(--border-subtle)] bg-[var(--bg-code)] my-2 overflow-hidden" data-code-raw="${encodedRaw}" data-code-ext="${escapeHtml(ext)}">` +
    `<div class="omnia-code-header">` +
    `<div class="flex items-center gap-2"><span class="font-semibold text-[var(--accent-cyan)]">${escapeHtml(cleanLang)}</span><span>${lineCount}L</span>` +
    (previewable
      ? `<button type="button" class="omnia-code-tab active" data-code-tab="code">Code</button><button type="button" class="omnia-code-tab" data-code-tab="preview">Preview</button>`
      : '') +
    `</div>` +
    `<div class="flex items-center gap-1">` +
    `<button type="button" class="omnia-code-btn" data-code-action="lines" title="Toggle line numbers">#</button>` +
    `<button type="button" class="omnia-code-btn" data-code-action="wrap" title="Toggle word wrap">Wrap</button>` +
    `<button type="button" class="omnia-code-btn" data-code-action="download" title="Download code">Save</button>` +
    `<button type="button" class="omnia-code-btn" data-code-action="copy" title="Copy code">Copy</button>` +
    `</div></div>` +
    `<pre data-code-pane="code" class="hljs m-0 border-0 rounded-none overflow-x-auto"><code>${linesHtml}</code></pre>` +
    (previewable ? `<div data-code-pane="preview" hidden>${previewHtml}</div>` : '') +
    `</div>`
  );
}

/**
 * Render Markdown + offline KaTeX/mhchem + IDE Code Cards + Callout Alerts + Footnotes +
 * clickable [S###] / [G###] / [1] citation chips with safe DOMPurify sanitization.
 */
export function renderRichMarkdown(raw: string, opts: { citations?: boolean } = {}): string {
  if (!raw) return '';

  const mathTokens: Array<{ key: string; html: string }> = [];
  const blockTokens: Array<{ key: string; html: string }> = [];
  const inlineCodeTokens: Array<{ key: string; raw: string }> = [];
  let tokenIdx = 0;

  let working = raw.replace(/\r\n/g, '\n');

  // 0. Extract footnote definitions `[^id]: text`
  const footnotes = new Map<string, string>();
  const footnoteOrder: string[] = [];
  working = working.replace(/^\[\^([A-Za-z0-9_-]+)\]:\s+(.+)$/gm, (_m, id: string, body: string) => {
    footnotes.set(id, body.trim());
    return '';
  });

  // 1. Protect fenced code blocks (``` or ~~~) BEFORE scanning inline code or math
  const codePlaceholders: Array<{ key: string; block: string }> = [];
  working = working.replace(/(?:```|~~~)([a-zA-Z0-9_+#.-]*)[ \t]*\n([\s\S]*?)(?:```|~~~)/g, (_m, lang: string, body: string) => {
    const key = `@@OMNIACODE_${tokenIdx++}@@`;
    codePlaceholders.push({ key, block: `\`\`\`${lang}\n${body}\`\`\`` });
    return key;
  });

  // 2. Protect inline code spans (`...`) BEFORE math scanning so `$PATH` stays literal
  working = working.replace(/`([^`\n]+)`/g, (full) => {
    const key = `@@OMNIAIC_${tokenIdx++}@@`;
    inlineCodeTokens.push({ key, raw: full });
    return key;
  });

  // 3. Extract GitHub Callout Alerts (> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION])
  working = working.replace(
    /(?:^>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)\n?(?:^>[ \t]?.*\n?)*)/gim,
    (full) => {
      const lines = full.trimEnd().split('\n').map((l) => l.replace(/^>[ \t]?/, ''));
      const first = lines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i);
      if (!first) return full;
      const meta = ALERT_LABELS[first[1].toUpperCase()] ?? ALERT_LABELS.NOTE;
      const title = first[2]?.trim() || meta.label;
      const bodyMd = lines.slice(1).join('\n').trim();
      const bodyHtml = bodyMd ? (markedInstance.parse(bodyMd, { async: false }) as string) : '';
      const key = `@@OMNIAALERT_${tokenIdx++}@@`;
      blockTokens.push({
        key,
        html: `<div class="omnia-alert omnia-alert-${meta.cls}" role="note"><div class="omnia-alert-title">${escapeHtml(title)}</div><div class="omnia-alert-body">${bodyHtml}</div></div>`,
      });
      return `\n${key}\n`;
    },
  );

  // 4. Display LaTeX: $$...$$, \[...\], and bare \begin{align|equation|bmatrix|cases...}
  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderDisplayMathCard(expr) });
    return key;
  });
  working = working.replace(/\\\[([\s\S]+?)\\\]/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderDisplayMathCard(expr) });
    return key;
  });
  working = working.replace(
    /\\begin\{(align\*?|equation\*?|gather\*?|multline\*?|bmatrix|pmatrix|vmatrix|Bmatrix|matrix|cases|split)\}([\s\S]+?)\\end\{\1\}/g,
    (full) => {
      const key = `@@OMNIAMATH_${tokenIdx++}@@`;
      mathTokens.push({ key, html: renderDisplayMathCard(full) });
      return key;
    },
  );

  // 5. Inline LaTeX: \(...\), currency-safe $...$, and bare \ce{...} / \pu{...}
  working = working.replace(/\\\(((?:[^\n]|\n(?!\n))+?)\\\)/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderLatexSegment(expr.replace(/\s*\n\s*/g, ' '), false) });
    return key;
  });
  working = working.replace(/(^|[^\\$\d])\$(?![ \t])((?:[^$\n]|\n(?!\n)){1,320}?)(?<![ \t])\$(?!\d)/g, (full, pre: string, expr: string) => {
    if (expr.includes('\n') && (/^\s*\d/.test(expr) || !/(?:\\[a-zA-Z]+|[_^{}=])/.test(expr))) {
      return full;
    }
    if (/^\d+(?:[.,]\d+)?(?:\s*(?:and|or|to|USD|EUR|VND)\b.*)?$/i.test(expr.trim())) {
      return full;
    }
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderLatexSegment(expr.replace(/\s*\n\s*/g, ' '), false) });
    return `${pre}${key}`;
  });
  working = working.replace(/\\(?:ce|pu)\{([^{}\n]+)\}/g, (full) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderLatexSegment(full, false) });
    return key;
  });

  // 6. Footnote references `[^id]`
  working = working.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (full, id: string) => {
    if (!footnotes.has(id)) return full;
    let idx = footnoteOrder.indexOf(id);
    if (idx === -1) idx = footnoteOrder.push(id) - 1;
    const key = `@@OMNIAFN_${tokenIdx++}@@`;
    blockTokens.push({
      key,
      html: `<sup class="text-[var(--accent-cyan)] font-mono-num">[${idx + 1}]</sup>`,
    });
    return key;
  });

  // 7. Clickable inline citations `[S001]`, `[G001]`, and `[1]`..`[99]` (excluding markdown links `[1](...)`)
  if (opts.citations !== false) {
    working = working.replace(/\[((?:[SG]\d{1,4})|(?:\d{1,2}))\](?!\()/g, (_full, cid: string) => {
      const key = `@@OMNIACIT_${tokenIdx++}@@`;
      const kind = cid.startsWith('S') ? 'web' : cid.startsWith('G') ? 'global' : 'num';
      blockTokens.push({
        key,
        html: `<button type="button" class="omnia-citation-chip omnia-cit-${kind}" data-citation-id="${escapeHtml(cid)}" title="Inspect source ${escapeHtml(cid)}">${escapeHtml(cid)}</button>`,
      });
      return key;
    });
  }

  // Restore inline code and fenced code blocks before marked runs
  for (const ic of inlineCodeTokens) {
    working = working.replace(ic.key, ic.raw);
  }
  for (const cp of codePlaceholders) {
    working = working.replace(cp.key, cp.block);
  }

  const renderer = {
    code({ text, lang }: { text: string; lang?: string }) {
      return buildCodeCardHtml(text, lang);
    },
  };

  markedInstance.use({ renderer });
  let html = markedInstance.parse(working, { async: false }) as string;

  if (footnoteOrder.length > 0) {
    const items = footnoteOrder
      .map((id, idx) => `<li><span class="font-mono-num text-[var(--accent-cyan)]">[${idx + 1}]</span> ${escapeHtml(footnotes.get(id) ?? '')}</li>`)
      .join('');
    html += `<section class="mt-3 pt-2 border-t border-[var(--border-subtle)] text-[11.5px] text-[var(--ink-secondary)]"><ol class="list-none pl-0 space-y-1">${items}</ol></section>`;
  }

  html = DOMPurify.sanitize(html, {
    ADD_ATTR: [
      'data-mermaid',
      'data-code-raw',
      'data-code-ext',
      'data-code-tab',
      'data-code-pane',
      'data-code-action',
      'data-line',
      'data-copy-tex',
      'data-citation-id',
      'sandbox',
      'srcdoc',
      'hidden',
      'aria-hidden',
      'xmlns',
      'viewBox',
      'd',
      'fill',
      'stroke',
    ],
    ADD_TAGS: ['iframe', 'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'annotation'],
  });

  for (const bt of blockTokens) {
    html = html.replace(bt.key, bt.html);
  }
  for (const mt of mathTokens) {
    html = html.replace(mt.key, mt.html);
  }

  return html;
}

/**
 * Delegated click handler for IDE Code Cards (Copy/Lines/Wrap/Download/Code-vs-Preview),
 * Copy TeX buttons, and clickable [S###]/[G###]/[1] citation chips.
 */
export function handleRichMarkdownClick(
  e: MouseEvent,
  callbacks: {
    onCitationClick?: (citationId: string) => void;
    onNotify?: (msg: string) => void;
  } = {},
): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const citBtn = target.closest<HTMLButtonElement>('[data-citation-id]');
  if (citBtn) {
    const cid = citBtn.dataset.citationId || '';
    if (cid) callbacks.onCitationClick?.(cid);
    return;
  }

  const copyTexBtn = target.closest<HTMLButtonElement>('[data-copy-tex]');
  if (copyTexBtn) {
    const tex = decodeURIComponent(copyTexBtn.dataset.copyTex || '');
    void navigator.clipboard?.writeText(tex).then(
      () => {
        copyTexBtn.textContent = 'Copied';
        setTimeout(() => {
          copyTexBtn.textContent = 'TeX';
        }, 1200);
        callbacks.onNotify?.('Copied LaTeX source');
      },
      () => callbacks.onNotify?.('Clipboard unavailable'),
    );
    return;
  }

  const tabBtn = target.closest<HTMLButtonElement>('[data-code-tab]');
  if (tabBtn) {
    const card = tabBtn.closest<HTMLElement>('.omnia-code-card');
    const tab = tabBtn.dataset.codeTab;
    if (card && tab) {
      card.querySelectorAll<HTMLButtonElement>('[data-code-tab]').forEach((b) => {
        b.classList.toggle('active', b === tabBtn);
      });
      card.querySelectorAll<HTMLElement>('[data-code-pane]').forEach((pane) => {
        pane.hidden = pane.dataset.codePane !== tab;
      });
    }
    return;
  }

  const actionBtn = target.closest<HTMLButtonElement>('[data-code-action]');
  if (actionBtn) {
    const card = actionBtn.closest<HTMLElement>('.omnia-code-card');
    if (!card) return;
    const action = actionBtn.dataset.codeAction;
    const rawCode = decodeURIComponent(card.dataset.codeRaw || '');
    const ext = card.dataset.codeExt || 'txt';

    if (action === 'lines') {
      card.classList.toggle('show-lines');
    } else if (action === 'wrap') {
      card.classList.toggle('wrap-lines');
    } else if (action === 'copy') {
      void navigator.clipboard?.writeText(rawCode).then(
        () => {
          actionBtn.textContent = 'Copied';
          setTimeout(() => {
            actionBtn.textContent = 'Copy';
          }, 1200);
          callbacks.onNotify?.('Copied code block');
        },
        () => callbacks.onNotify?.('Clipboard unavailable'),
      );
    } else if (action === 'download') {
      const blob = new Blob([rawCode], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `omnia-snippet.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      callbacks.onNotify?.(`Saved omnia-snippet.${ext}`);
    }
  }
}

export const LATEX_15_TEMPLATES: ComposerTemplate[] = [
  {
    id: 'math-euler',
    title: 'Euler Identity',
    category: 'Math',
    latex: 'e^{i\\pi} + 1 = 0',
    displayMode: false,
    preview: 'e^(i*pi) + 1 = 0',
  },
  {
    id: 'math-gaussian',
    title: 'Gaussian Integral',
    category: 'Math',
    latex: '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    displayMode: true,
    preview: 'Int(-inf..inf) e^(-x^2) dx = sqrt(pi)',
  },
  {
    id: 'math-series',
    title: 'Basel Series',
    category: 'Math',
    latex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
    displayMode: true,
    preview: 'Sum(1/n^2) = pi^2/6',
  },
  {
    id: 'math-matrix',
    title: '2x2 Matrix',
    category: 'Math',
    latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    displayMode: true,
    preview: 'Matrix [a b; c d]',
  },
  {
    id: 'math-bayes',
    title: 'Bayes Theorem',
    category: 'Math',
    latex: 'P(A\\mid B) = \\frac{P(B\\mid A)\\,P(A)}{P(B)}',
    displayMode: true,
    preview: 'P(A|B) = P(B|A)P(A)/P(B)',
  },
  {
    id: 'phys-schrodinger',
    title: 'Schrodinger Equation',
    category: 'Physics',
    latex: 'i\\hbar\\frac{\\partial \\Psi}{\\partial t} = \\hat{H}\\Psi',
    displayMode: true,
    preview: 'i*hbar dPsi/dt = H*Psi',
  },
  {
    id: 'phys-maxwell',
    title: 'Faraday Curl',
    category: 'Physics',
    latex: '\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}',
    displayMode: true,
    preview: 'curl(E) = -dB/dt',
  },
  {
    id: 'phys-ampere',
    title: 'Ampere Circuital',
    category: 'Physics',
    latex: '\\oint \\mathbf{B} \\cdot d\\mathbf{l} = \\mu_0 I_{\\text{enc}}',
    displayMode: true,
    preview: 'Int B.dl = mu0 I',
  },
  {
    id: 'phys-lorentz',
    title: 'Lorentz Factor',
    category: 'Physics',
    latex: '\\gamma = \\frac{1}{\\sqrt{1 - v^2 / c^2}}',
    displayMode: false,
    preview: 'gamma = 1/sqrt(1 - v^2/c^2)',
  },
  {
    id: 'phys-planck',
    title: 'Planck Energy',
    category: 'Physics',
    latex: 'E = h\\nu = \\frac{hc}{\\lambda}',
    displayMode: false,
    preview: 'E = h*nu = hc/lambda',
  },
  {
    id: 'chem-haber',
    title: 'Haber Equilibrium',
    category: 'Chemistry',
    latex: '\\ce{N2 + 3H2 <=> 2NH3}',
    displayMode: true,
    preview: 'N2 + 3H2 <=> 2NH3',
  },
  {
    id: 'chem-nernst',
    title: 'Nernst Equation',
    category: 'Chemistry',
    latex: 'E = E^\\circ - \\frac{RT}{nF}\\ln Q',
    displayMode: false,
    preview: 'E = E0 - (RT/nF)lnQ',
  },
  {
    id: 'chem-gibbs',
    title: 'Gibbs Free Energy',
    category: 'Chemistry',
    latex: '\\Delta G = \\Delta H - T\\Delta S',
    displayMode: false,
    preview: 'dG = dH - T*dS',
  },
  {
    id: 'chem-acid',
    title: 'Acid Dissociation',
    category: 'Chemistry',
    latex: '\\ce{HA + H2O <=> H3O+ + A-}',
    displayMode: false,
    preview: 'HA + H2O <=> H3O+ + A-',
  },
  {
    id: 'chem-arrhenius',
    title: 'Arrhenius Rate',
    category: 'Chemistry',
    latex: 'k = A e^{-E_a / (RT)}',
    displayMode: false,
    preview: 'k = A exp(-Ea/RT)',
  },
];
