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

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderLatexSegment(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return `<code class="omnia-math-fallback">${escapeHtml(expr)}</code>`;
  }
}

/**
 * Render Markdown + offline KaTeX/mhchem + highlight.js code + safe DOMPurify sanitization.
 * Preserves Mermaid blocks as <div class="omnia-mermaid" data-src="..."> for deferred SVG render.
 */
export function renderRichMarkdown(raw: string): string {
  if (!raw) return '';

  const mathTokens: Array<{ key: string; html: string }> = [];
  let tokenIdx = 0;

  // Protect fenced code blocks before scanning $...$ math delimiters
  const codePlaceholders: Array<{ key: string; block: string }> = [];
  let protectedSrc = raw.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const key = `@@OMNIACODE_${tokenIdx++}@@`;
    codePlaceholders.push({ key, block: `\`\`\`${lang}\n${body}\`\`\`` });
    return key;
  });

  // Display math $$...$$ and \[...\]
  protectedSrc = protectedSrc.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({
      key,
      html: `<div class="my-2 overflow-x-auto py-1">${renderLatexSegment(expr, true)}</div>`,
    });
    return key;
  });
  protectedSrc = protectedSrc.replace(/\\\[([\s\S]+?)\\\]/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({
      key,
      html: `<div class="my-2 overflow-x-auto py-1">${renderLatexSegment(expr, true)}</div>`,
    });
    return key;
  });

  // Inline math $...$ and \(...\)
  protectedSrc = protectedSrc.replace(/\\\(([\s\S]+?)\\\)/g, (_m, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderLatexSegment(expr, false) });
    return key;
  });
  protectedSrc = protectedSrc.replace(/(^|[^\\$])\$([^\n$]{1,280}?)\$/g, (_m, pre: string, expr: string) => {
    const key = `@@OMNIAMATH_${tokenIdx++}@@`;
    mathTokens.push({ key, html: renderLatexSegment(expr, false) });
    return `${pre}${key}`;
  });

  for (const cp of codePlaceholders) {
    protectedSrc = protectedSrc.replace(cp.key, cp.block);
  }

  const renderer = {
    code({ text, lang }: { text: string; lang?: string }) {
      const cleanLang = (lang || '').trim().toLowerCase();
      if (cleanLang === 'mermaid') {
        const encoded = encodeURIComponent(text);
        return `<div class="omnia-mermaid rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] p-3 my-2 overflow-x-auto" data-mermaid="${encoded}"><pre class="text-xs text-[var(--ink-muted)]">${escapeHtml(text)}</pre></div>`;
      }
      let highlighted = escapeHtml(text);
      try {
        if (cleanLang && hljs.getLanguage(cleanLang)) {
          highlighted = hljs.highlight(text, { language: cleanLang }).value;
        } else {
          highlighted = hljs.highlightAuto(text).value;
        }
      } catch {
        // fallback already escaped
      }
      const badge = cleanLang ? `<div class="flex items-center justify-between px-3 py-1 border-b border-[var(--border-subtle)] text-[11px] font-mono-num text-[var(--ink-muted)]"><span>${escapeHtml(cleanLang)}</span></div>` : '';
      return `<div class="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-code)] my-2 overflow-hidden">${badge}<pre class="hljs m-0 border-0 rounded-none"><code>${highlighted}</code></pre></div>`;
    },
  };

  markedInstance.use({ renderer });
  let html = markedInstance.parse(protectedSrc, { async: false }) as string;

  html = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-mermaid', 'aria-hidden', 'xmlns', 'viewBox', 'd', 'fill', 'stroke'],
    ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'annotation'],
  });

  for (const mt of mathTokens) {
    html = html.replace(mt.key, mt.html);
  }

  return html;
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
