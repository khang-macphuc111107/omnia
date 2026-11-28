import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Download,
  Eye,
  FileText,
  Headphones,
  HelpCircle,
  Layers,
  Maximize2,
  MessageCircle,
  MessageSquareQuote,
  Mic,
  Minimize2,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Share2,
  Shuffle,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-solid';
import { api } from '@/api/client';
import { flashNotice, openCitationSource, openQuoteBtw, openSourcePreview, privacyMask } from '@/state/studio';
import type { EffortLevel } from '@/types';
import { handleRichMarkdownClick, renderRichMarkdown } from '@/utils/markdown';
import { downloadTextFile, maskText } from '@/utils/privacy';

const ARTIFACT_KINDS = [
  { kind: 'audio_overview', label: 'Audio Overview' },
  { kind: 'mind_map', label: 'Mind Map' },
  { kind: 'flashcards', label: 'Flashcards' },
  { kind: 'quiz', label: 'Quiz' },
  { kind: 'slide_deck', label: 'Slide Deck' },
  { kind: 'data_table', label: 'Data Table' },
  { kind: 'infographic', label: 'Infographic' },
  { kind: 'briefing', label: 'Briefing' },
  { kind: 'study_guide', label: 'Study Guide' },
  { kind: 'faq', label: 'FAQ' },
  { kind: 'timeline', label: 'Timeline' },
] as const;

const PODCAST_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

type MasteryRating = 'again' | 'hard' | 'good' | 'easy';

interface CitationEvidence {
  marker: string;
  sourceId: string;
  chunkIdx?: number;
  sourceTitle?: string;
  excerpt?: string;
}

interface QaTurnItem {
  q: string;
  a: string;
  citations: string[];
  evidence?: CitationEvidence[];
  groundedCount?: number;
}

interface FlashcardItem {
  idx: number;
  q: string;
  a: string;
  hint?: string;
  difficulty?: string;
  citations: string[];
  sourceId?: string;
}

interface QuizQuestionItem {
  id: string;
  number: number;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  citations: string[];
  sourceId?: string;
}

interface MindMapNode {
  id: string;
  label: string;
  citations: string[];
  sourceId?: string;
  children: MindMapNode[];
}

interface PositionedMindNode {
  node: MindMapNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  childCount: number;
}

interface PositionedMindEdge {
  id: string;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface PodcastTurnItem {
  index: number;
  speaker: string;
  hostRole: 'A' | 'B';
  text: string;
  chapter?: string;
  citations: string[];
  sourceId?: string;
}

interface FaqEntryItem {
  question: string;
  answer: string;
  citations: string[];
}

interface TimelineEventItem {
  order: number;
  label: string;
  title: string;
  detail: string;
  citations: string[];
}

function normalizeArtifactKind(raw: unknown): string {
  const norm = String(raw ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (norm === 'infographic_spec' || norm === 'infographicspec') return 'infographic';
  if (norm === 'mindmap') return 'mind_map';
  if (norm === 'audiooverview' || norm === 'audio' || norm === 'podcast') return 'audio_overview';
  if (norm === 'slidedeck' || norm === 'slides') return 'slide_deck';
  if (norm === 'datatable') return 'data_table';
  if (norm === 'studyguide') return 'study_guide';
  if (norm === 'briefing_doc') return 'briefing';
  if (norm === 'flashcard') return 'flashcards';
  return norm;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

function getStructuredRoot(art: Record<string, unknown>): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (typeof art.structured_json === 'string') {
    try {
      const parsed = JSON.parse(art.structured_json);
      const rec = asRecord(parsed);
      if (rec) base = rec;
    } catch {
      base = {};
    }
  } else {
    const rec = asRecord(art.structured_json);
    if (rec) base = rec;
  }
  const payload = asRecord(base.parsed_payload);
  return payload ? { ...base, ...payload } : base;
}

function extractInlineCitationMarkers(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[([A-Za-z0-9_.-]+:\d+|[SG]\d{1,4}|\d{1,2})\](?!\()/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const token = m[0];
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
    m = re.exec(text);
  }
  return out;
}

function extractCitationList(obj: Record<string, unknown> | null, fallbackText = ''): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (obj) {
    for (const key of ['citation_ids', 'citations']) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') {
            push(item);
          } else {
            const rec = asRecord(item);
            if (rec) push(rec.marker ?? rec.citation_marker ?? rec.source_id ?? rec.id);
          }
        }
      }
    }
    if (typeof obj.citation === 'string') push(obj.citation);
    if (out.length === 0 && typeof obj.source_id === 'string') push(obj.source_id);
  }
  if (out.length === 0 && fallbackText) {
    for (const marker of extractInlineCitationMarkers(fallbackText)) {
      push(marker);
    }
  }
  return out;
}

function extractSlides(art: Record<string, unknown>): string[] {
  const struct = getStructuredRoot(art);
  const rawSlides = Array.isArray(art.slides) ? art.slides : Array.isArray(struct.slides) ? struct.slides : null;
  if (rawSlides && rawSlides.length > 0) {
    return rawSlides.map((s, idx) => {
      if (typeof s === 'string') return s;
      const rec = asRecord(s);
      if (!rec) return JSON.stringify(s, null, 2);
      const title = String(rec.title ?? `Slide ${idx + 1}`);
      const bullets = Array.isArray(rec.bullets) ? rec.bullets.map((b) => `- ${String(b)}`).join('\n') : '';
      const notes = rec.speaker_notes ? `\n\n> **Notes:** ${String(rec.speaker_notes)}` : '';
      return `## ${title}\n\n${bullets}${notes}`.trim();
    });
  }
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const byRule = md.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean);
  if (byRule.length > 1) return byRule;
  const byHeading = md.split(/(?=^##\s)/m).map((s) => s.trim()).filter(Boolean);
  return byHeading.length > 0 ? byHeading : [md || 'Slide deck generated'];
}

function extractFlashcards(art: Record<string, unknown>): FlashcardItem[] {
  const struct = getStructuredRoot(art);
  const rawCards = Array.isArray(struct.cards) ? struct.cards : Array.isArray(art.cards) ? art.cards : null;
  if (rawCards && rawCards.length > 0) {
    return rawCards.map((c, idx) => {
      const rec = asRecord(c) ?? {};
      const q = String(rec.front ?? rec.question ?? rec.prompt ?? `Card ${idx + 1}`);
      const a = String(rec.back ?? rec.answer ?? 'Review cited notebook source passages for the grounded explanation.');
      return {
        idx,
        q,
        a,
        hint: rec.hint ? String(rec.hint) : undefined,
        difficulty: rec.difficulty ? String(rec.difficulty) : undefined,
        citations: extractCitationList(rec, `${q} ${a}`),
        sourceId: rec.source_id ? String(rec.source_id) : undefined,
      };
    });
  }

  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const cardBlocks = md.split(/(?=^###\s+Card\s+\d+)/mi).map((b) => b.trim()).filter(Boolean);
  const parsedCards: FlashcardItem[] = [];
  for (const block of cardBlocks) {
    const frontMatch = block.match(/(?:^|\n)[-*]?\s*\*\*Front:\*\*\s*(.+)/i);
    const backMatch = block.match(/(?:^|\n)[-*]?\s*\*\*Back:\*\*\s*([\s\S]+?)(?=\n[-*]?\s*\*\*Hint:|\n###|$)/i);
    const hintMatch = block.match(/(?:^|\n)[-*]?\s*\*\*Hint:\*\*\s*(.+)/i);
    if (frontMatch && backMatch) {
      const q = frontMatch[1].trim();
      const a = backMatch[1].trim();
      parsedCards.push({
        idx: parsedCards.length,
        q,
        a,
        hint: hintMatch ? hintMatch[1].trim() : undefined,
        citations: extractInlineCitationMarkers(`${q} ${a}`),
      });
    }
  }
  if (parsedCards.length > 0) return parsedCards;

  const pairs: FlashcardItem[] = [];
  const blocks = md.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b && !b.startsWith('# '));
  for (let i = 0; i < blocks.length; i += 2) {
    const q = blocks[i];
    const a = blocks[i + 1] ?? 'Review cited notebook source passages for the grounded explanation.';
    pairs.push({
      idx: pairs.length,
      q,
      a,
      citations: extractInlineCitationMarkers(`${q} ${a}`),
    });
  }
  return pairs.length > 0
    ? pairs
    : [{ idx: 0, q: 'Prompt', a: md || 'Flashcard generated', citations: [] }];
}

function parseQuizQuestions(art: Record<string, unknown>): QuizQuestionItem[] {
  const struct = getStructuredRoot(art);
  const rawQuestions = Array.isArray(struct.questions)
    ? struct.questions
    : Array.isArray(art.questions)
      ? art.questions
      : null;

  if (rawQuestions && rawQuestions.length > 0) {
    const parsed: QuizQuestionItem[] = [];
    for (let i = 0; i < rawQuestions.length; i++) {
      const rec = asRecord(rawQuestions[i]);
      if (!rec) continue;
      const question = String(rec.question ?? rec.prompt ?? rec.text ?? `Question ${i + 1}`).trim();
      const rawOpts = Array.isArray(rec.options) ? rec.options : Array.isArray(rec.choices) ? rec.choices : [];
      const options = rawOpts
        .map((o) => {
          if (typeof o === 'string') return o.trim();
          const oRec = asRecord(o);
          return oRec ? String(oRec.text ?? oRec.label ?? oRec.value ?? '').trim() : String(o);
        })
        .filter(Boolean);
      if (options.length < 2) continue;

      let correctIndex = 0;
      if (typeof rec.correct_index === 'number' && Number.isFinite(rec.correct_index)) {
        correctIndex = rec.correct_index;
      } else if (typeof rec.correctIndex === 'number' && Number.isFinite(rec.correctIndex)) {
        correctIndex = rec.correctIndex;
      } else if (typeof rec.answer_index === 'number' && Number.isFinite(rec.answer_index)) {
        correctIndex = rec.answer_index;
      } else if (typeof rec.correct_answer === 'string' || typeof rec.answer === 'string') {
        const ans = String(rec.correct_answer ?? rec.answer ?? '').trim();
        const letterIdx = OPTION_LETTERS.indexOf(ans.toUpperCase() as (typeof OPTION_LETTERS)[number]);
        if (letterIdx >= 0 && letterIdx < options.length) {
          correctIndex = letterIdx;
        } else {
          const matchIdx = options.findIndex((o) => o.toLowerCase() === ans.toLowerCase());
          if (matchIdx >= 0) correctIndex = matchIdx;
        }
      }
      correctIndex = Math.max(0, Math.min(options.length - 1, correctIndex));

      const citations = extractCitationList(rec, `${question} ${String(rec.explanation ?? '')}`);
      const explanation = String(
        rec.explanation ??
          rec.rationale ??
          `Option ${OPTION_LETTERS[correctIndex] ?? correctIndex + 1} is directly supported by the cited notebook evidence.`,
      ).trim();

      parsed.push({
        id: String(rec.id ?? `q-${i + 1}`),
        number: Number(rec.question_number ?? i + 1),
        question,
        options,
        correctIndex,
        explanation,
        citations,
        sourceId: rec.source_id ? String(rec.source_id) : undefined,
      });
    }
    if (parsed.length > 0) return parsed;
  }

  // Markdown fallback parser
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const sections = md
    .split(/(?=^###\s*(?:Question|Q)\s*\d+|^Q\d+[:.)]\s)/mi)
    .map((s) => s.trim())
    .filter(Boolean);
  const results: QuizQuestionItem[] = [];

  for (const sec of sections) {
    const lines = sec.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const options: string[] = [];
    const promptLines: string[] = [];
    let correctIndex = 0;
    let explanation = '';
    const citations: string[] = [];

    for (const line of lines) {
      if (/^###\s*(?:Question|Q)\s*\d+/i.test(line)) continue;
      const optMatch = line.match(/^(?:[-*]\s*)?(?:\*\*)?([A-F])[).:]\s*(?:\*\*)?\s*(.+)$/);
      if (optMatch) {
        options.push(optMatch[2].trim());
        continue;
      }
      const ansMatch = line.match(/^>?\s*(?:\*\*)?Answer(?:\*\*)?:\s*(?:\*\*)?([A-F])(?:\*\*)?(.*)$/i);
      if (ansMatch) {
        const idx = OPTION_LETTERS.indexOf(ansMatch[1].toUpperCase() as (typeof OPTION_LETTERS)[number]);
        if (idx >= 0) correctIndex = idx;
        const tail = ansMatch[2]?.trim() ?? '';
        for (const c of extractInlineCitationMarkers(tail)) {
          if (!citations.includes(c)) citations.push(c);
        }
        continue;
      }
      const expMatch = line.match(/^>?\s*(?:\*\*)?Explanation(?:\*\*)?:\s*(.+)$/i);
      if (expMatch) {
        explanation = expMatch[1].trim();
        for (const c of extractInlineCitationMarkers(explanation)) {
          if (!citations.includes(c)) citations.push(c);
        }
        continue;
      }
      if (options.length === 0) {
        promptLines.push(line.replace(/^Q\d+[:.)]\s*/i, ''));
      }
    }

    if (options.length >= 2) {
      const qText = promptLines.join(' ').trim() || `Question ${results.length + 1}`;
      for (const c of extractInlineCitationMarkers(sec)) {
        if (!citations.includes(c)) citations.push(c);
      }
      const clampedCorrect = Math.max(0, Math.min(options.length - 1, correctIndex));
      results.push({
        id: `q-md-${results.length + 1}`,
        number: results.length + 1,
        question: qText,
        options,
        correctIndex: clampedCorrect,
        explanation:
          explanation ||
          `Option ${OPTION_LETTERS[clampedCorrect] ?? clampedCorrect + 1} matches the cited notebook source passage.`,
        citations,
      });
    }
  }
  return results;
}

function cleanMermaidShapeLabel(raw: string): string {
  let s = raw.trim();
  const patterns: RegExp[] = [
    /^[A-Za-z0-9_.-]+\(\((.+)\)\)$/,
    /^[A-Za-z0-9_.-]+\(\[(.+)\]\)$/,
    /^[A-Za-z0-9_.-]+\(\((.+)\)\)$/,
    /^[A-Za-z0-9_.-]+\{\{(.+)\}\}$/,
    /^[A-Za-z0-9_.-]+\["(.+)"\]$/,
    /^[A-Za-z0-9_.-]+\[(.+)\]$/,
    /^[A-Za-z0-9_.-]+\((.+)\)$/,
    /^\(\((.+)\)\)$/,
    /^\{\{(.+)\}\}$/,
    /^\[(.+)\]$/,
    /^\((.+)\)$/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      s = m[1].trim();
      break;
    }
  }
  return s.replace(/^["']|["']$/g, '').trim() || 'Topic';
}

function buildMindNodeFromJson(raw: unknown, fallbackId: string): MindMapNode {
  if (typeof raw === 'string') {
    const label = raw.trim() || 'Branch';
    return {
      id: fallbackId,
      label,
      citations: extractInlineCitationMarkers(label),
      children: [],
    };
  }
  const rec = asRecord(raw) ?? {};
  const label = String(rec.label ?? rec.title ?? rec.name ?? rec.root ?? fallbackId).trim() || 'Topic';
  const id = String(rec.id ?? rec.node_id ?? fallbackId);
  const rawChildren = Array.isArray(rec.children)
    ? rec.children
    : Array.isArray(rec.branches)
      ? rec.branches
      : [];
  const children = rawChildren.map((ch, i) => buildMindNodeFromJson(ch, `${id}_${i}`));
  return {
    id,
    label,
    citations: extractCitationList(rec, label),
    sourceId: rec.source_id ? String(rec.source_id) : undefined,
    children,
  };
}

function parseMermaidMindMap(code: string, fallbackTitle: string): MindMapNode | null {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim() ?? '';

  // Case A: Mermaid `mindmap` indentation tree
  if (/^mindmap\b/i.test(firstNonEmpty)) {
    const stack: Array<{ indent: number; node: MindMapNode }> = [];
    let root: MindMapNode | null = null;
    let counter = 0;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || /^mindmap\b/i.test(trimmed) || trimmed.startsWith('%%')) continue;
      const expanded = rawLine.replace(/\t/g, '  ');
      const indent = expanded.length - expanded.trimStart().length;
      const label = cleanMermaidShapeLabel(trimmed);
      const node: MindMapNode = {
        id: `mm_${counter++}`,
        label,
        citations: extractInlineCitationMarkers(label),
        children: [],
      };
      if (!root) {
        root = node;
        stack.push({ indent, node });
        continue;
      }
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      stack[stack.length - 1].node.children.push(node);
      stack.push({ indent, node });
    }
    return root;
  }

  // Case B: Mermaid `flowchart` / `graph` edge list (emitted by `omnia-notebook` deterministic builder)
  const labels = new Map<string, string>();
  const childrenMap = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const order: string[] = [];

  const ensureId = (id: string) => {
    if (!inDegree.has(id)) {
      inDegree.set(id, 0);
      order.push(id);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^(?:flowchart|graph|subgraph|end|style|classDef)\b/i.test(line) || line.startsWith('%%')) {
      continue;
    }
    const edgeMatch = line.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\]|\([^)]*\))?\s*--+[->]*\s*(?:\|[^|]*\|\s*)?([A-Za-z0-9_.-]+)(?:\[[^\]]*\]|\([^)]*\))?/);
    if (edgeMatch) {
      const from = edgeMatch[1];
      const to = edgeMatch[2];
      ensureId(from);
      ensureId(to);
      const list = childrenMap.get(from) ?? [];
      if (!list.includes(to)) {
        list.push(to);
        childrenMap.set(from, list);
        inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
      }
    }
    const declRe = /([A-Za-z0-9_.-]+)\s*(?:\["([^"]+)"\]|\[([^\]]+)\]|\(\(([^)]+)\)\)|\(([^)]+)\))/g;
    let m: RegExpExecArray | null = declRe.exec(line);
    while (m) {
      const id = m[1];
      const label = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? id).trim();
      ensureId(id);
      labels.set(id, label);
      m = declRe.exec(line);
    }
  }

  if (order.length === 0) return null;
  const rootId =
    order.find((id) => id === 'root') ??
    order.find((id) => (inDegree.get(id) ?? 0) === 0) ??
    order[0];
  const visited = new Set<string>();

  const toTree = (id: string): MindMapNode => {
    visited.add(id);
    const label = labels.get(id) ?? (id === 'root' ? fallbackTitle : id);
    const kids = (childrenMap.get(id) ?? [])
      .filter((cid) => !visited.has(cid))
      .map((cid) => toTree(cid));
    return {
      id,
      label,
      citations: extractInlineCitationMarkers(label),
      children: kids,
    };
  };
  return toTree(rootId);
}

function parseMindMapTree(art: Record<string, unknown>): MindMapNode {
  const title = String(art.title ?? 'Mind Map').trim() || 'Mind Map';
  const struct = getStructuredRoot(art);

  // 1. Enriched `structured_json.tree`
  if (asRecord(struct.tree)) {
    return buildMindNodeFromJson(struct.tree, 'root');
  }

  // 2. `structured_json.root` as object or string + `branches`
  if (asRecord(struct.root)) {
    return buildMindNodeFromJson(struct.root, 'root');
  }
  if (typeof struct.root === 'string' && Array.isArray(struct.branches)) {
    return {
      id: 'root',
      label: struct.root.trim() || title,
      citations: extractCitationList(struct, struct.root),
      children: struct.branches.map((b, i) => buildMindNodeFromJson(b, `b_${i}`)),
    };
  }

  // 3. Deterministic `structured_json.nodes`
  if (Array.isArray(struct.nodes) && struct.nodes.length > 0) {
    return {
      id: 'root',
      label: title,
      citations: [],
      children: struct.nodes.map((n, i) => buildMindNodeFromJson(n, `n_${i}`)),
    };
  }

  // 4. Mermaid block (`structured_json.mermaid` or fenced ```mermaid```)
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const fenced = md.match(/```mermaid\s*\n([\s\S]*?)```/i)?.[1];
  const mermaidSrc = typeof struct.mermaid === 'string' && struct.mermaid.trim() ? struct.mermaid : fenced ?? md;
  const fromMermaid = parseMermaidMindMap(mermaidSrc, title);
  if (fromMermaid) return fromMermaid;

  // 5. Markdown heading / bullet fallback
  const root: MindMapNode = { id: 'root', label: title, citations: [], children: [] };
  let activeBranch: MindMapNode = root;
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let idx = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('# ')) continue;
    if (t.startsWith('## ')) {
      const label = t.replace(/^##+\s+/, '').trim();
      activeBranch = { id: `h_${idx++}`, label, citations: extractInlineCitationMarkers(label), children: [] };
      root.children.push(activeBranch);
    } else if (/^[-*]\s+/.test(t)) {
      const label = t.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim();
      activeBranch.children.push({
        id: `li_${idx++}`,
        label,
        citations: extractInlineCitationMarkers(label),
        children: [],
      });
    }
  }
  return root;
}

function layoutMindMap(
  root: MindMapNode,
  collapsedIds: Set<string>,
): { nodes: PositionedMindNode[]; edges: PositionedMindEdge[]; width: number; height: number } {
  const NODE_W = 166;
  const NODE_H = 34;
  const X_GAP = 48;
  const Y_GAP = 14;
  const PAD = 24;

  const nodes: PositionedMindNode[] = [];
  const edges: PositionedMindEdge[] = [];

  const countVisibleLeaves = (n: MindMapNode): number => {
    if (n.children.length === 0 || collapsedIds.has(n.id)) return 1;
    let sum = 0;
    for (const c of n.children) sum += countVisibleLeaves(c);
    return Math.max(1, sum);
  };

  let maxX = PAD + NODE_W;
  let maxY = PAD + NODE_H;

  const place = (n: MindMapNode, depth: number, topSlot: number): { centerY: number; x: number } => {
    const isCollapsed = collapsedIds.has(n.id);
    const visibleChildren = isCollapsed ? [] : n.children;
    const x = PAD + depth * (NODE_W + X_GAP);
    let y: number;

    if (visibleChildren.length === 0) {
      y = PAD + topSlot * (NODE_H + Y_GAP);
    } else {
      let cursor = topSlot;
      const childCenters: Array<{ id: string; x: number; cy: number }> = [];
      for (const ch of visibleChildren) {
        const span = countVisibleLeaves(ch);
        const res = place(ch, depth + 1, cursor);
        childCenters.push({ id: ch.id, x: res.x, cy: res.centerY });
        cursor += span;
      }
      const firstCy = childCenters[0].cy;
      const lastCy = childCenters[childCenters.length - 1].cy;
      y = (firstCy + lastCy) / 2 - NODE_H / 2;

      const parentCy = y + NODE_H / 2;
      for (const cc of childCenters) {
        edges.push({
          id: `${n.id}->${cc.id}`,
          fromId: n.id,
          toId: cc.id,
          x1: x + NODE_W,
          y1: parentCy,
          x2: cc.x,
          y2: cc.cy,
        });
      }
    }

    nodes.push({
      node: n,
      x,
      y,
      w: NODE_W,
      h: NODE_H,
      depth,
      hasChildren: n.children.length > 0,
      isCollapsed,
      childCount: n.children.length,
    });
    if (x + NODE_W + PAD > maxX) maxX = x + NODE_W + PAD;
    if (y + NODE_H + PAD > maxY) maxY = y + NODE_H + PAD;
    return { centerY: y + NODE_H / 2, x };
  };

  place(root, 0, 0);
  return {
    nodes,
    edges,
    width: Math.max(420, Math.ceil(maxX)),
    height: Math.max(220, Math.ceil(maxY)),
  };
}

function collectBranchIds(node: MindMapNode, out: string[] = []): string[] {
  if (node.children.length > 0) {
    out.push(node.id);
    for (const c of node.children) collectBranchIds(c, out);
  }
  return out;
}

function findMindNodeById(node: MindMapNode, id: string): MindMapNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findMindNodeById(c, id);
    if (found) return found;
  }
  return null;
}

function inferHostRole(speaker: string, idx: number): 'A' | 'B' {
  const s = speaker.trim().toLowerCase();
  if (s.includes('host b') || s.includes('maya') || s.includes('speaker b') || s.includes('speaker 2') || s.endsWith(' b')) {
    return 'B';
  }
  if (s.includes('host a') || s.includes('alex') || s.includes('speaker a') || s.includes('speaker 1') || s.endsWith(' a')) {
    return 'A';
  }
  return idx % 2 === 0 ? 'A' : 'B';
}

function parsePodcastTurns(art: Record<string, unknown>): PodcastTurnItem[] {
  const struct = getStructuredRoot(art);
  const out: PodcastTurnItem[] = [];

  const pushRawTurn = (raw: unknown, chapter?: string) => {
    const rec = asRecord(raw);
    if (!rec) return;
    const text = String(rec.text ?? rec.line ?? rec.content ?? rec.utterance ?? '').trim();
    if (!text) return;
    const speaker = String(rec.speaker ?? rec.host ?? (out.length % 2 === 0 ? 'Host A' : 'Host B')).trim();
    out.push({
      index: out.length,
      speaker,
      hostRole: inferHostRole(speaker, out.length),
      text,
      chapter,
      citations: extractCitationList(rec, text),
      sourceId: rec.source_id ? String(rec.source_id) : undefined,
    });
  };

  const directTurns = Array.isArray(struct.turns) ? struct.turns : Array.isArray(art.turns) ? art.turns : null;
  if (directTurns && directTurns.length > 0) {
    for (const t of directTurns) pushRawTurn(t);
    if (out.length > 0) return out;
  }

  if (Array.isArray(struct.chapters) && struct.chapters.length > 0) {
    for (const ch of struct.chapters) {
      const chRec = asRecord(ch);
      if (!chRec) continue;
      const chTitle = chRec.title ? String(chRec.title) : undefined;
      if (Array.isArray(chRec.turns)) {
        for (const t of chRec.turns) pushRawTurn(t, chTitle);
      }
    }
    if (out.length > 0) return out;
  }

  // Markdown / script speaker-line fallback
  const md = String(art.content_markdown ?? art.body ?? art.content ?? '');
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let activeChapter: string | undefined;
  const speakerRe = /^(?:[-*]\s*)?(?:\*\*)?(Host\s*[AB]|Alex|Maya|Speaker\s*[12AB])(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^##+\s+/.test(line)) {
      activeChapter = line.replace(/^##+\s+/, '').trim();
      continue;
    }
    const m = line.match(speakerRe);
    if (m) {
      const speaker = m[1].trim();
      const text = m[2].trim();
      out.push({
        index: out.length,
        speaker,
        hostRole: inferHostRole(speaker, out.length),
        text,
        chapter: activeChapter,
        citations: extractInlineCitationMarkers(text),
      });
    }
  }
  if (out.length > 0) return out;

  // Paragraph fallback alternating Host A / Host B
  const paras = md
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s+/, '').trim())
    .filter((p) => p.length > 10 && !p.startsWith('```'));
  for (let i = 0; i < paras.length; i++) {
    const speaker = i % 2 === 0 ? 'Host A' : 'Host B';
    out.push({
      index: i,
      speaker,
      hostRole: i % 2 === 0 ? 'A' : 'B',
      text: paras[i],
      citations: extractInlineCitationMarkers(paras[i]),
    });
  }
  return out;
}

function parseFaqEntries(art: Record<string, unknown>): FaqEntryItem[] {
  const struct = getStructuredRoot(art);
  if (!Array.isArray(struct.entries)) return [];
  return struct.entries
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return null;
      const question = String(rec.question ?? rec.q ?? '').trim();
      const answer = String(rec.answer ?? rec.a ?? '').trim();
      if (!question || !answer) return null;
      return {
        question,
        answer,
        citations: extractCitationList(rec, answer),
      };
    })
    .filter((x): x is FaqEntryItem => x !== null);
}

function parseTimelineEvents(art: Record<string, unknown>): TimelineEventItem[] {
  const struct = getStructuredRoot(art);
  if (!Array.isArray(struct.events)) return [];
  return struct.events
    .map((item, idx) => {
      const rec = asRecord(item);
      if (!rec) return null;
      const title = String(rec.title ?? rec.heading ?? `Event ${idx + 1}`).trim();
      const detail = String(rec.detail ?? rec.summary ?? rec.description ?? '').trim();
      const label = String(rec.label ?? rec.date ?? `Milestone ${idx + 1}`).trim();
      return {
        order: Number(rec.order ?? idx + 1),
        label,
        title,
        detail,
        citations: extractCitationList(rec, `${title} ${detail}`),
      };
    })
    .filter((x): x is TimelineEventItem => x !== null);
}

function stripSpeechTechnicalMarkers(text: string): string {
  return text
    .replace(/\[pause:\s*\d+\s*m?s\]/gi, ', ')
    .replace(/\[[A-Za-z0-9_.-]+:\d+\]/g, '')
    .replace(/\[(?:[SG]\d{1,4}|\d{1,2})\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSvgLabel(text: string, maxChars = 22): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

export function AtelierView() {
  const [layoutMode, setLayoutMode] = createSignal<'gemini' | 'notebook' | 'ke_nhau'>('ke_nhau');
  const [notebooks, setNotebooks] = createSignal<Array<Record<string, unknown>>>([]);
  const [activeNbId, setActiveNbId] = createSignal<string>('');
  const [sources, setSources] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedSourceIds, setSelectedSourceIds] = createSignal<string[]>([]);
  const [artifacts, setArtifacts] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedArtifact, setSelectedArtifact] = createSignal<Record<string, unknown> | null>(null);
  const [artifactExpanded, setArtifactExpanded] = createSignal(false);
  const [artifactFocusPrompt, setArtifactFocusPrompt] = createSignal('');

  // Flashcards Spaced-Repetition State
  const [flashcardIdx, setFlashcardIdx] = createSignal(0);
  const [flashcardFlip, setFlashcardFlip] = createSignal(false);
  const [flashcardOrder, setFlashcardOrder] = createSignal<number[]>([]);
  const [flashcardRatings, setFlashcardRatings] = createSignal<Record<number, MasteryRating>>({});
  const [showCardHint, setShowCardHint] = createSignal(false);

  // Slide Deck State
  const [slideIdx, setSlideIdx] = createSignal(0);

  // Mind Map Interactive SVG State
  const [mindMapViewMode, setMindMapViewMode] = createSignal<'graph' | 'raw'>('graph');
  const [mindZoom, setMindZoom] = createSignal(1);
  const [mindPan, setMindPan] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
  const [collapsedMindNodes, setCollapsedMindNodes] = createSignal<string[]>([]);
  const [selectedMindNodeId, setSelectedMindNodeId] = createSignal<string>('root');
  const [isDraggingMind, setIsDraggingMind] = createSignal(false);
  let dragOrigin = { px: 0, py: 0, startX: 0, startY: 0 };

  // Graded MCQ Quiz State
  const [quizAnswers, setQuizAnswers] = createSignal<Record<string, number>>({});
  const [quizViewMode, setQuizViewMode] = createSignal<'interactive' | 'raw'>('interactive');

  // 2-Host Podcast Player + Join Mode State
  const [audioRate, setAudioRate] = createSignal<number>(1);
  const [podcastState, setPodcastState] = createSignal<'stopped' | 'playing' | 'paused'>('stopped');
  const [activePodcastTurn, setActivePodcastTurn] = createSignal<number>(0);
  const [podcastJoinPrompt, setPodcastJoinPrompt] = createSignal('');
  const [podcastJoinBusy, setPodcastJoinBusy] = createSignal(false);
  const [podcastJoinReply, setPodcastJoinReply] = createSignal<{ turnNum: number; q: string; a: string } | null>(null);
  const [podcastViewMode, setPodcastViewMode] = createSignal<'player' | 'raw'>('player');
  const [ttsFallbackMode, setTtsFallbackMode] = createSignal(false);

  // Sources / Ingest / Whisper / Share / Q&A State
  const [newSourceName, setNewSourceName] = createSignal('');
  const [newSourceText, setNewSourceText] = createSignal('');
  const [audioPath, setAudioPath] = createSignal('');
  const [shareUrl, setShareUrl] = createSignal('');
  const [shareGateState, setShareGateState] = createSignal<'idle' | 'ok' | 'auth_required' | 'captcha_blocked' | 'error'>('idle');
  const [askPrompt, setAskPrompt] = createSignal('');
  const [effort, setEffort] = createSignal<EffortLevel>('max');
  const [qaHistory, setQaHistory] = createSignal<QaTurnItem[]>([]);
  const [statusMsg, setStatusMsg] = createSignal('');

  let audioElRef: HTMLAudioElement | undefined;
  let askInputRef: HTMLInputElement | undefined;
  let knownSourceIds = new Set<string>();
  let playbackToken = 0;
  let teleprompterTimer: ReturnType<typeof setTimeout> | null = null;
  const inlineCitationLookup = new Map<string, CitationEvidence>();

  const ttsSupported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined';

  const nbIdOf = (nb: Record<string, unknown>): string => String(nb.notebook_id ?? nb.id ?? '');
  const sourceIdOf = (s: Record<string, unknown>): string => String(s.source_id ?? s.id ?? '');

  const stopPodcastPlayback = (resetTurn = false) => {
    playbackToken += 1;
    if (teleprompterTimer) {
      clearTimeout(teleprompterTimer);
      teleprompterTimer = null;
    }
    if (ttsSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore synthesis cancel error in restricted runtimes
      }
    }
    if (audioElRef) {
      try {
        audioElRef.pause();
        if (resetTurn) audioElRef.currentTime = 0;
      } catch {
        // ignore media element error
      }
    }
    setPodcastState('stopped');
    if (resetTurn) setActivePodcastTurn(0);
  };

  const refreshNotebookData = async (nbId: string, resetSelection = false) => {
    if (!nbId) return;
    const [srcRes, artRes] = await Promise.all([api.listSources(nbId), api.listArtifacts(nbId)]);
    if (srcRes.ok && Array.isArray(srcRes.data.sources)) {
      const nextSources = srcRes.data.sources;
      setSources(nextSources);
      const nextIds = nextSources.map(sourceIdOf).filter(Boolean);
      if (resetSelection) {
        setSelectedSourceIds(nextIds);
        knownSourceIds = new Set(nextIds);
      } else {
        const nextSet = new Set(nextIds);
        const kept = selectedSourceIds().filter((id) => nextSet.has(id));
        const newlyAdded = nextIds.filter((id) => !knownSourceIds.has(id));
        setSelectedSourceIds([...kept, ...newlyAdded]);
        knownSourceIds = nextSet;
      }
    }
    if (artRes.ok && Array.isArray(artRes.data.artifacts)) {
      setArtifacts(artRes.data.artifacts);
      if (resetSelection) {
        stopPodcastPlayback(true);
        setSelectedArtifact(artRes.data.artifacts[0] ?? null);
      } else if (artRes.data.artifacts.length > 0 && !selectedArtifact()) {
        setSelectedArtifact(artRes.data.artifacts[0]);
      }
    }
  };

  const resetArtifactInteractiveState = (art: Record<string, unknown> | null) => {
    stopPodcastPlayback(true);
    setSlideIdx(0);
    setFlashcardIdx(0);
    setFlashcardFlip(false);
    setFlashcardRatings({});
    setShowCardHint(false);
    setQuizAnswers({});
    setQuizViewMode('interactive');
    setMindMapViewMode('graph');
    setMindZoom(1);
    setMindPan({ x: 0, y: 0 });
    setCollapsedMindNodes([]);
    setSelectedMindNodeId('root');
    setPodcastJoinReply(null);
    setPodcastViewMode('player');
    if (art) {
      const cards = extractFlashcards(art);
      setFlashcardOrder(cards.map((c) => c.idx));
      const tree = parseMindMapTree(art);
      setSelectedMindNodeId(tree.id);
    } else {
      setFlashcardOrder([]);
    }
  };

  const selectArtifactRecord = (art: Record<string, unknown>) => {
    setSelectedArtifact(art);
    resetArtifactInteractiveState(art);
  };

  const selectedSourceSet = createMemo(() => new Set(selectedSourceIds()));
  const groundedCountLabel = createMemo(() => `${selectedSourceIds().length}/${sources().length} grounded`);

  const toggleSourceSelection = (sid: string) => {
    if (!sid) return;
    const cur = selectedSourceIds();
    if (cur.includes(sid)) {
      setSelectedSourceIds(cur.filter((id) => id !== sid));
    } else {
      setSelectedSourceIds([...cur, sid]);
    }
  };

  const selectAllSources = () => {
    setSelectedSourceIds(sources().map(sourceIdOf).filter(Boolean));
  };

  const selectNoSources = () => {
    setSelectedSourceIds([]);
  };

  const selectedArtifactKind = createMemo(() => (selectedArtifact() ? normalizeArtifactKind(selectedArtifact()!.kind) : ''));
  const activeSlides = createMemo(() => (selectedArtifact() ? extractSlides(selectedArtifact()!) : []));
  const activeCards = createMemo(() => (selectedArtifact() ? extractFlashcards(selectedArtifact()!) : []));
  const activeQuizQuestions = createMemo(() => (selectedArtifact() ? parseQuizQuestions(selectedArtifact()!) : []));
  const activeMindMapTree = createMemo(() => (selectedArtifact() ? parseMindMapTree(selectedArtifact()!) : null));
  const activePodcastTurns = createMemo(() => (selectedArtifact() ? parsePodcastTurns(selectedArtifact()!) : []));
  const activeFaqEntries = createMemo(() => (selectedArtifact() ? parseFaqEntries(selectedArtifact()!) : []));
  const activeTimelineEvents = createMemo(() => (selectedArtifact() ? parseTimelineEvents(selectedArtifact()!) : []));

  createEffect(() => {
    const cards = activeCards();
    if (flashcardOrder().length !== cards.length) {
      setFlashcardOrder(cards.map((c) => c.idx));
    }
  });

  const orderedFlashcards = createMemo(() => {
    const cards = activeCards();
    const order = flashcardOrder();
    if (order.length !== cards.length) return cards;
    return order.map((i) => cards[i]).filter((c): c is FlashcardItem => Boolean(c));
  });

  const currentFlashcard = createMemo(() => {
    const list = orderedFlashcards();
    if (list.length === 0) return null;
    const safeIdx = Math.max(0, Math.min(list.length - 1, flashcardIdx()));
    return list[safeIdx];
  });

  const masteredFlashcardCount = createMemo(() => {
    const ratings = flashcardRatings();
    return Object.values(ratings).filter((r) => r === 'good' || r === 'easy').length;
  });

  const quizScore = createMemo(() => {
    const questions = activeQuizQuestions();
    const answers = quizAnswers();
    let answered = 0;
    let correct = 0;
    for (const q of questions) {
      if (typeof answers[q.id] === 'number') {
        answered += 1;
        if (answers[q.id] === q.correctIndex) correct += 1;
      }
    }
    const total = questions.length;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return { answered, correct, total, pct };
  });

  const mindMapLayout = createMemo(() => {
    const tree = activeMindMapTree();
    if (!tree) return null;
    return layoutMindMap(tree, new Set(collapsedMindNodes()));
  });

  const selectedMindNode = createMemo(() => {
    const tree = activeMindMapTree();
    if (!tree) return null;
    return findMindNodeById(tree, selectedMindNodeId()) ?? tree;
  });

  const handleShuffleFlashcards = () => {
    const len = activeCards().length;
    if (len <= 1) return;
    const arr = Array.from({ length: len }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    setFlashcardOrder(arr);
    setFlashcardIdx(0);
    setFlashcardFlip(false);
    setShowCardHint(false);
    flashNotice('Shuffled flashcard deck');
  };

  const handleRateFlashcard = (rating: MasteryRating) => {
    const card = currentFlashcard();
    if (!card) return;
    setFlashcardRatings({ ...flashcardRatings(), [card.idx]: rating });
    const total = orderedFlashcards().length;
    if (flashcardIdx() < total - 1) {
      setFlashcardIdx((i) => Math.min(total - 1, i + 1));
      setFlashcardFlip(false);
      setShowCardHint(false);
    } else {
      setFlashcardFlip(false);
      setShowCardHint(false);
    }
  };

  const prevFlashcard = () => {
    setFlashcardIdx((i) => Math.max(0, i - 1));
    setFlashcardFlip(false);
    setShowCardHint(false);
  };

  const nextFlashcard = () => {
    const len = orderedFlashcards().length;
    setFlashcardIdx((i) => Math.min(Math.max(0, len - 1), i + 1));
    setFlashcardFlip(false);
    setShowCardHint(false);
  };

  onMount(() => {
    void (async () => {
      const res = await api.listNotebooks();
      if (res.ok && Array.isArray(res.data.notebooks) && res.data.notebooks.length > 0) {
        setNotebooks(res.data.notebooks);
        const id = nbIdOf(res.data.notebooks[0]);
        if (id) {
          setActiveNbId(id);
          await refreshNotebookData(id, true);
        }
      }
    })();

    const onKeyDown = (e: KeyboardEvent) => {
      if (selectedArtifactKind() !== 'flashcards' || layoutMode() !== 'ke_nhau') return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          activeEl.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        setFlashcardFlip((f) => !f);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevFlashcard();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextFlashcard();
      } else if (e.key === '1') {
        handleRateFlashcard('again');
      } else if (e.key === '2') {
        handleRateFlashcard('hard');
      } else if (e.key === '3') {
        handleRateFlashcard('good');
      } else if (e.key === '4') {
        handleRateFlashcard('easy');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      stopPodcastPlayback(false);
    });
  });

  const handleCreateNb = async () => {
    const res = await api.createNotebook(`Atelier ${notebooks().length + 1}`);
    if (res.ok && res.data.notebook) {
      const nb = res.data.notebook as Record<string, unknown>;
      setNotebooks([nb, ...notebooks()]);
      const id = nbIdOf(nb);
      if (id) {
        setActiveNbId(id);
        await refreshNotebookData(id, true);
      }
    } else if (!res.ok) {
      setStatusMsg(`Create error (${res.error.code}): ${res.error.message}`);
    }
  };

  const ensureNotebookId = async (): Promise<string> => {
    if (activeNbId()) return activeNbId();
    await handleCreateNb();
    return activeNbId();
  };

  const handleIngest = async () => {
    if (!newSourceName().trim() || !newSourceText().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const res = await api.ingestSource(nbId, newSourceName().trim(), newSourceText());
    if (res.ok) {
      setNewSourceName('');
      setNewSourceText('');
      setStatusMsg('Source indexed into Atelier Notebook');
      await refreshNotebookData(nbId, false);
    } else {
      setStatusMsg(`Ingest error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (!activeNbId()) return;
    const res = await api.deleteSource(activeNbId(), sourceId);
    if (res.ok) {
      setStatusMsg(`Deleted source ${sourceId.slice(0, 10)}`);
      await refreshNotebookData(activeNbId(), false);
    } else {
      setStatusMsg(`Delete error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleTranscribe = async () => {
    if (!audioPath().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    setStatusMsg('Running Whisper audio transcription...');
    const res = await api.transcribeAudio(nbId, audioPath().trim());
    if (res.ok) {
      setAudioPath('');
      setStatusMsg('Audio transcribed & ingested');
      await refreshNotebookData(nbId, false);
    } else {
      setStatusMsg(`Whisper (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleReconcileSync = async () => {
    const nbId = activeNbId();
    if (!nbId) return;
    const res = await api.reconcileNotebookSync(nbId);
    setStatusMsg(res.ok ? 'Notebook tombstones reconciled' : `Sync error (${res.error.code}): ${res.error.message}`);
    await refreshNotebookData(nbId, false);
  };

  const handleImportShare = async () => {
    if (!shareUrl().trim()) return;
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const res = await api.safeJson<Record<string, unknown>>('/api/notebooks/import-share', {
      method: 'POST',
      body: JSON.stringify({ notebook_id: nbId, share_url: shareUrl().trim() }),
    });
    if (res.ok) {
      const gate = String(res.data.state ?? res.data.status ?? '');
      if (gate === 'auth_required' || gate === 'captcha_blocked') {
        setShareGateState(gate);
        setStatusMsg(`Import halted honestly (${gate}) — never bypassing auth/CAPTCHA`);
      } else {
        setShareGateState('ok');
        setStatusMsg('Public Gemini share imported');
        await refreshNotebookData(nbId, false);
      }
    } else {
      const code = res.error.code;
      setShareGateState(code === 'auth_required' || code === 'captcha_blocked' ? code : 'error');
      setStatusMsg(`Import blocked (${code}): ${res.error.message}`);
    }
  };

  const extractCleanSourceText = (rawText: string): string => {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.content === 'string') return parsed.content;
      } catch {
        // treat as plain text
      }
    }
    return rawText;
  };

  const handlePreviewSource = async (
    s: Record<string, unknown>,
    highlight?: { marker?: string; chunkIdx?: number; excerpt?: string },
  ) => {
    const sid = sourceIdOf(s);
    const title = String(s.title || s.safe_filename || s.filename || sid || 'source.txt');
    const nbId = activeNbId();
    let content = String(s.excerpt ?? s.preview ?? '');
    let mimeType = String(s.mime_type ?? s.mimeType ?? '');
    if (nbId && sid) {
      const res = await api.getNotebookSourceContent(nbId, sid);
      if (res.ok) {
        content = extractCleanSourceText(res.text);
        if (res.contentType && !res.contentType.includes('application/json')) {
          mimeType = res.contentType;
        }
      }
    }

    const baseContent = content || `Source "${title}" (${String(s.source_kind ?? s.kind ?? 'document')})`;
    let finalContent = baseContent;
    if (highlight && (highlight.excerpt || highlight.marker || typeof highlight.chunkIdx === 'number')) {
      const refLabel = highlight.marker || (typeof highlight.chunkIdx === 'number' ? `${sid}:${highlight.chunkIdx}` : sid);
      const excerptBody = highlight.excerpt?.trim() || baseContent.slice(0, 320).trim();
      finalContent =
        `> [!IMPORTANT] Cited Excerpt — ${refLabel}\n` +
        `> ${excerptBody.replace(/\r?\n/g, '\n> ')}\n\n` +
        `---\n\n${baseContent}`;
    }

    openSourcePreview({
      id: sid,
      name: title,
      kind: highlight ? 'markdown' : undefined,
      mimeType,
      sizeBytes: typeof s.size_bytes === 'number' ? s.size_bytes : typeof s.byte_size === 'number' ? s.byte_size : undefined,
      sha256: s.sha256 ? String(s.sha256) : undefined,
      content: finalContent,
    });
  };

  const jumpToCitation = async (rawCitation: string, fallbackExcerpt?: string, knownEvidence?: CitationEvidence) => {
    const trimmed = rawCitation.trim();
    const cleaned = trimmed.replace(/^\[|\]$/g, '').trim();
    const lookedUp = knownEvidence ?? inlineCitationLookup.get(cleaned) ?? inlineCitationLookup.get(trimmed);
    const targetRef = lookedUp?.sourceId || cleaned;

    let parsedSourceId = targetRef;
    let parsedChunkIdx: number | undefined = lookedUp?.chunkIdx;
    const colonMatch = targetRef.match(/^([A-Za-z0-9_.-]+):(\d+)$/);
    if (colonMatch) {
      parsedSourceId = colonMatch[1];
      parsedChunkIdx = Number.parseInt(colonMatch[2], 10);
    }

    const srcList = sources();
    let matched: Record<string, unknown> | undefined = srcList.find((s) => {
      const sid = sourceIdOf(s);
      const rem = String(s.remote_id ?? '');
      return sid === parsedSourceId || (rem && rem === parsedSourceId);
    });

    if (!matched && parsedSourceId.length >= 4) {
      matched = srcList.find((s) => sourceIdOf(s).startsWith(parsedSourceId));
    }

    if (!matched) {
      const idxMatch = cleaned.match(/^[SG]?0*(\d+)$/i);
      if (idxMatch) {
        const oneBased = Number.parseInt(idxMatch[1], 10);
        if (oneBased >= 1 && oneBased <= srcList.length) {
          matched = srcList[oneBased - 1];
        }
      }
    }

    if (!matched) {
      const lower = cleaned.toLowerCase();
      matched = srcList.find((s) => {
        const title = String(s.title || s.safe_filename || s.filename || '').toLowerCase();
        return title && (title.includes(lower) || lower.includes(title));
      });
    }

    const excerpt = lookedUp?.excerpt || fallbackExcerpt;
    if (matched) {
      await handlePreviewSource(matched, {
        marker: trimmed.startsWith('[') ? trimmed : `[${cleaned}]`,
        chunkIdx: parsedChunkIdx,
        excerpt,
      });
      return;
    }

    if (/^[SG]\d{2,4}$/i.test(cleaned)) {
      openCitationSource(cleaned);
      return;
    }

    openSourcePreview({
      id: cleaned || 'citation',
      name: `Citation ${trimmed || cleaned}`,
      kind: 'markdown',
      content:
        `> [!NOTE] Cited Reference: \`${trimmed || cleaned}\`\n` +
        `> ${excerpt || 'No local notebook source matched this citation ID; verify notebook sources or ingest the referenced document.'}`,
    });
  };

  const preprocessMarkdownCitations = (rawMd: string, evidenceList?: CitationEvidence[]): string => {
    const srcList = sources();
    const evidenceByMarker = new Map<string, CitationEvidence>();
    if (evidenceList) {
      for (const ev of evidenceList) {
        evidenceByMarker.set(ev.marker, ev);
        evidenceByMarker.set(ev.marker.replace(/^\[|\]$/g, ''), ev);
      }
    }

    return rawMd.replace(/\[([A-Za-z0-9_.-]{3,}):(\d+)\](?!\()/g, (full, sid: string, chunkStr: string) => {
      const chunkIdx = Number.parseInt(chunkStr, 10);
      const srcIdx = srcList.findIndex((s) => sourceIdOf(s) === sid);
      const chipId = srcIdx >= 0 ? `S${srcIdx + 1}` : `S${inlineCitationLookup.size + 1}`;
      const ev = evidenceByMarker.get(full) ?? evidenceByMarker.get(`${sid}:${chunkStr}`);
      inlineCitationLookup.set(chipId, {
        marker: full,
        sourceId: sid,
        chunkIdx,
        sourceTitle: ev?.sourceTitle,
        excerpt: ev?.excerpt,
      });
      return `[${chipId}]`;
    });
  };

  const executeGroundedAsk = async (
    queryText: string,
    preset?: 'explain' | 'verify' | 'summarize' | 'code',
  ): Promise<{ ok: boolean; answer: string; citations: string[]; evidence: CitationEvidence[] }> => {
    const nbId = await ensureNotebookId();
    if (!nbId) return { ok: false, answer: 'No active notebook', citations: [], evidence: [] };

    const activeIds = selectedSourceIds();
    if (sources().length > 0 && activeIds.length === 0) {
      const msg = 'Select at least one source checkbox to run grounded Q&A.';
      setStatusMsg(msg);
      flashNotice(msg);
      return { ok: false, answer: msg, citations: [], evidence: [] };
    }

    const res = await api.safeJson<Record<string, unknown>>('/api/notebooks/ask', {
      method: 'POST',
      body: JSON.stringify({
        notebook_id: nbId,
        query: queryText,
        prompt: queryText,
        effort: effort(),
        preset,
        source_ids: activeIds,
        sourceIds: activeIds,
      }),
    });

    if (res.ok) {
      const inner = (asRecord(res.data.result) ?? res.data) as Record<string, unknown>;
      const turnRec = asRecord(inner.turn);
      const llmRec = asRecord(inner.llm_usage);
      const packRec = asRecord(inner.pack);
      const verRec = asRecord(inner.verification);

      const answer = String(
        inner.answer ??
          inner.response_markdown ??
          turnRec?.response_markdown ??
          llmRec?.text ??
          JSON.stringify(inner, null, 2),
      );

      const evidence: CitationEvidence[] = [];
      const rawEv = Array.isArray(packRec?.evidence) ? packRec.evidence : [];
      for (const item of rawEv) {
        const rec = asRecord(item);
        if (!rec) continue;
        const sid = String(rec.source_id ?? '');
        const cidx = typeof rec.chunk_idx === 'number' ? rec.chunk_idx : undefined;
        const marker = String(rec.citation_marker ?? (sid ? `[${sid}:${cidx ?? 0}]` : ''));
        if (marker && sid) {
          const ev: CitationEvidence = {
            marker,
            sourceId: sid,
            chunkIdx: cidx,
            sourceTitle: rec.source_title ? String(rec.source_title) : undefined,
            excerpt: rec.excerpt ? String(rec.excerpt) : undefined,
          };
          evidence.push(ev);
          inlineCitationLookup.set(marker.replace(/^\[|\]$/g, ''), ev);
        }
      }

      const rawCitations: unknown[] = Array.isArray(inner.citations)
        ? inner.citations
        : Array.isArray(turnRec?.citations)
          ? turnRec.citations
          : Array.isArray(verRec?.verified_citations)
            ? verRec.verified_citations
            : [];
      const citations = rawCitations
        .map((c) => {
          if (typeof c === 'string') return c;
          const rec = asRecord(c);
          return rec ? String(rec.marker ?? rec.citation_marker ?? rec.source_id ?? '') : String(c);
        })
        .filter(Boolean);
      const finalCitations = citations.length > 0 ? citations : extractInlineCitationMarkers(answer);

      setQaHistory([
        ...qaHistory(),
        {
          q: preset ? `[${preset.toUpperCase()}] ${queryText}` : queryText,
          a: answer,
          citations: finalCitations,
          evidence,
          groundedCount: activeIds.length,
        },
      ]);
      return { ok: true, answer, citations: finalCitations, evidence };
    }

    const errText = `Error (${res.error.code}): ${res.error.message}`;
    setQaHistory([...qaHistory(), { q: queryText, a: errText, citations: [], groundedCount: activeIds.length }]);
    return { ok: false, answer: errText, citations: [], evidence: [] };
  };

  const handleAsk = async (preset?: 'explain' | 'verify' | 'summarize' | 'code') => {
    const presetPrompts: Record<'explain' | 'verify' | 'summarize' | 'code', string> = {
      explain: 'Explain the key concepts across the selected grounded sources with inline citations.',
      verify: 'Verify factual claims and cross-check consistency across the selected sources with citations.',
      summarize: 'Summarize the selected notebook sources into a concise grounded executive brief with citations.',
      code: 'Extract concrete implementation patterns and code examples grounded in the selected sources.',
    };
    const q = askPrompt().trim() || (preset ? presetPrompts[preset] : '');
    if (!q) return;
    setAskPrompt('');
    await executeGroundedAsk(q, preset);
  };

  const handleGenerateArtifact = async (kind: string, label: string) => {
    const nbId = await ensureNotebookId();
    if (!nbId) return;
    const activeIds = selectedSourceIds();
    if (sources().length > 0 && activeIds.length === 0) {
      const msg = 'Select at least one source checkbox before generating an artifact.';
      setStatusMsg(msg);
      flashNotice(msg);
      return;
    }

    setStatusMsg(`Generating ${label} (${activeIds.length}/${sources().length} sources)...`);
    const focus = artifactFocusPrompt().trim() || undefined;
    const res = await api.safeJson<Record<string, unknown>>('/api/notebooks/artifacts/generate', {
      method: 'POST',
      body: JSON.stringify({
        notebook_id: nbId,
        kind,
        title: label,
        focus_prompt: focus,
        source_ids: activeIds,
        sourceIds: activeIds,
      }),
    });
    if (res.ok && res.data.artifact) {
      const art = res.data.artifact as Record<string, unknown>;
      setArtifacts([art, ...artifacts()]);
      selectArtifactRecord(art);
      setStatusMsg(`Generated ${label}`);
    } else if (!res.ok) {
      setStatusMsg(`Artifact error (${res.error.code}): ${res.error.message}`);
    }
  };

  // Mind Map Controls
  const toggleMindCollapse = (nodeId: string) => {
    const cur = collapsedMindNodes();
    if (cur.includes(nodeId)) {
      setCollapsedMindNodes(cur.filter((id) => id !== nodeId));
    } else {
      setCollapsedMindNodes([...cur, nodeId]);
    }
  };

  const populateAskForMindNode = (node: MindMapNode, sendImmediately = false) => {
    const prompt = `Explain "${node.label}" in detail using the selected grounded notebook sources with inline citations.`;
    setAskPrompt(prompt);
    if (sendImmediately) {
      void handleAsk();
      return;
    }
    askInputRef?.focus();
    flashNotice(`Populated Q&A for "${node.label}" — press Enter or Ask`);
  };

  // 2-Host Podcast Playback Engine (offline window.speechSynthesis + graceful teleprompter fallback)
  const speakPodcastTurn = (idx: number) => {
    const turns = activePodcastTurns();
    if (turns.length === 0 || idx < 0 || idx >= turns.length) {
      stopPodcastPlayback(false);
      return;
    }
    playbackToken += 1;
    const myToken = playbackToken;
    if (teleprompterTimer) {
      clearTimeout(teleprompterTimer);
      teleprompterTimer = null;
    }
    if (ttsSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore cancel failures
      }
    }

    setActivePodcastTurn(idx);
    setPodcastState('playing');
    const turn = turns[idx];
    const spoken = stripSpeechTechnicalMarkers(maskText(turn.text, privacyMask()));

    const startVisualAdvance = () => {
      setTtsFallbackMode(true);
      const wordCount = Math.max(4, spoken.split(/\s+/).filter(Boolean).length);
      const ms = Math.max(1600, Math.min(7500, Math.round((wordCount * 330) / audioRate())));
      teleprompterTimer = setTimeout(() => {
        if (myToken !== playbackToken) return;
        if (idx + 1 < turns.length) {
          speakPodcastTurn(idx + 1);
        } else {
          setPodcastState('stopped');
        }
      }, ms);
    };

    if (!ttsSupported || !spoken) {
      startVisualAdvance();
      return;
    }

    try {
      setTtsFallbackMode(false);
      const utter = new SpeechSynthesisUtterance(spoken);
      utter.rate = audioRate();
      utter.pitch = turn.hostRole === 'A' ? 0.92 : 1.14;
      utter.onend = () => {
        if (myToken !== playbackToken) return;
        if (idx + 1 < turns.length) {
          speakPodcastTurn(idx + 1);
        } else {
          setPodcastState('stopped');
        }
      };
      utter.onerror = () => {
        if (myToken !== playbackToken) return;
        startVisualAdvance();
      };
      window.speechSynthesis.speak(utter);
    } catch {
      startVisualAdvance();
    }
  };

  const handlePodcastPlayPause = () => {
    const turns = activePodcastTurns();
    if (turns.length === 0) return;

    if (podcastState() === 'playing') {
      playbackToken += 1;
      if (teleprompterTimer) {
        clearTimeout(teleprompterTimer);
        teleprompterTimer = null;
      }
      if (ttsSupported) {
        try {
          window.speechSynthesis.pause();
        } catch {
          try {
            window.speechSynthesis.cancel();
          } catch {
            // ignore
          }
        }
      }
      if (audioElRef) audioElRef.pause();
      setPodcastState('paused');
      return;
    }

    if (podcastState() === 'paused' && ttsSupported && !ttsFallbackMode()) {
      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
          setPodcastState('playing');
          return;
        }
      } catch {
        // fall through to restart from current turn
      }
    }

    const startIdx = activePodcastTurn() >= turns.length ? 0 : activePodcastTurn();
    speakPodcastTurn(startIdx);
  };

  const handleSetAudioSpeed = (rate: number) => {
    setAudioRate(rate);
    if (audioElRef) audioElRef.playbackRate = rate;
    if (podcastState() === 'playing') {
      speakPodcastTurn(activePodcastTurn());
    }
  };

  const handleExportPodcastScript = () => {
    const art = selectedArtifact();
    if (!art) return;
    const title = String(art.title ?? 'Audio Overview Script');
    const turns = activePodcastTurns();
    const lines = [
      `# ${title}`,
      '',
      `> Grounded 2-Host Audio Overview Script (${turns.length} turns)`,
      '',
      ...turns.map((t) => {
        const chap = t.chapter ? `### ${t.chapter}\n\n` : '';
        const cites = t.citations.length > 0 ? ` ${t.citations.join(' ')}` : '';
        return `${chap}**${t.speaker}:** ${t.text}${cites}\n`;
      }),
    ].join('\n');
    const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio-overview';
    downloadTextFile(`${safeName}.md`, maskText(lines, privacyMask()), 'text/markdown;charset=utf-8');
    flashNotice(`Exported ${safeName}.md`);
  };

  const handleJoinPodcast = async () => {
    const userQ = podcastJoinPrompt().trim();
    if (!userQ || podcastJoinBusy()) return;
    const turns = activePodcastTurns();
    const activeIdx = Math.max(0, Math.min(Math.max(0, turns.length - 1), activePodcastTurn()));
    const turn = turns[activeIdx];

    if (podcastState() === 'playing') {
      handlePodcastPlayPause();
    }

    const contextRef = turn
      ? `Interrupting Podcast at Turn #${activeIdx + 1} (${turn.speaker}: "${turn.text.slice(0, 140)}"): ${userQ}`
      : `Podcast Q&A: ${userQ}`;

    setPodcastJoinBusy(true);
    setPodcastJoinPrompt('');
    const result = await executeGroundedAsk(contextRef);
    setPodcastJoinBusy(false);
    setPodcastJoinReply({
      turnNum: activeIdx + 1,
      q: userQ,
      a: result.answer,
    });
  };

  return (
    <div data-testid="atelier-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Atelier Header */}
      <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <BookOpen class="w-4 h-4 text-[var(--accent-amber)] shrink-0" />
          <span class="font-bold text-[13.5px] truncate">Atelier Research Studio</span>
          <span class="omnia-badge font-mono-num text-[var(--accent-cyan)] shrink-0">NotebookLM++</span>
          <select
            value={activeNbId()}
            aria-label="Active Notebook"
            onChange={(e) => {
              const id = e.currentTarget.value;
              setActiveNbId(id);
              void refreshNotebookData(id, true);
            }}
            class="min-w-0 max-w-[180px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[12px]"
          >
            <For each={notebooks()}>
              {(nb) => <option value={nbIdOf(nb)}>{String(nb.title || nbIdOf(nb))}</option>}
            </For>
          </select>
          <button type="button" class="omnia-btn text-[11px] shrink-0" onClick={() => void handleCreateNb()}>
            <Plus class="w-3.5 h-3.5" />
            <span>New Notebook</span>
          </button>
          <button
            type="button"
            class="omnia-btn text-[11px] shrink-0"
            onClick={() => void handleReconcileSync()}
            title="Reconcile Sync Tombstones"
          >
            <RefreshCw class="w-3 h-3" />
            <span>Sync</span>
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <Show when={statusMsg()}>
            <span class="text-[11px] font-mono-num text-[var(--accent-cyan)] truncate max-w-[260px]">{statusMsg()}</span>
          </Show>
          <div class="omp-segmented text-[11.5px] shrink-0">
            {(
              [
                { id: 'gemini', label: 'Gemini' },
                { id: 'notebook', label: 'Notebook' },
                { id: 'ke_nhau', label: 'Kế nhau' },
              ] as const
            ).map((m) => (
              <button type="button" aria-pressed={layoutMode() === m.id} onClick={() => setLayoutMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3-Column Studio Grid */}
      <div
        class="flex-1 min-h-0 grid overflow-hidden"
        classList={{
          'grid-cols-1 lg:grid-cols-[minmax(195px,240px)_minmax(240px,1fr)_minmax(265px,360px)]':
            layoutMode() === 'ke_nhau' && !artifactExpanded(),
          'grid-cols-1 lg:grid-cols-[minmax(185px,215px)_minmax(220px,0.85fr)_minmax(340px,1.25fr)]':
            layoutMode() === 'ke_nhau' && artifactExpanded(),
          'grid-cols-1': layoutMode() === 'gemini',
          'grid-cols-1 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]': layoutMode() === 'notebook',
        }}
      >
        {/* Sources Column with Per-Source Grounding Checkboxes */}
        <Show when={layoutMode() !== 'gemini'}>
          <div class="min-w-0 min-h-0 border-r border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col overflow-hidden">
            <div class="p-2.5 border-b border-[var(--border-subtle)] space-y-1.5">
              <div class="flex items-center justify-between gap-1.5 min-w-0">
                <div class="flex items-center gap-1.5 min-w-0 text-[12px] font-semibold">
                  <FileText class="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0" />
                  <span class="truncate">Sources ({sources().length})</span>
                </div>
                <span
                  data-testid="atelier-grounded-count"
                  class="omnia-badge font-mono-num text-[10px] shrink-0"
                  classList={{
                    'text-[var(--status-emerald)]': selectedSourceIds().length > 0,
                    'text-[var(--status-coral)]': sources().length > 0 && selectedSourceIds().length === 0,
                  }}
                >
                  {groundedCountLabel()}
                </span>
              </div>
              <div class="flex items-center justify-between gap-1 text-[10.5px]">
                <span class="text-[var(--ink-muted)] truncate">Grounding scope</span>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-testid="atelier-sources-all"
                    class="omnia-btn px-1.5 py-0.5 text-[10px]"
                    onClick={selectAllSources}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    data-testid="atelier-sources-none"
                    class="omnia-btn px-1.5 py-0.5 text-[10px]"
                    onClick={selectNoSources}
                  >
                    None
                  </button>
                </div>
              </div>
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
              <For each={sources()}>
                {(s, idx) => {
                  const sid = sourceIdOf(s);
                  const isChecked = () => selectedSourceSet().has(sid);
                  const displayTitle = () =>
                    maskText(String(s.title || s.safe_filename || s.filename || sid), privacyMask());
                  return (
                    <div
                      class="p-2 rounded border bg-[var(--bg-panel)] text-[12px] flex items-start justify-between gap-1.5 min-w-0 transition-opacity"
                      classList={{
                        'border-[var(--border-accent)]': isChecked(),
                        'border-[var(--border-subtle)] opacity-65': !isChecked(),
                      }}
                    >
                      <label class="flex items-start gap-2 min-w-0 flex-1 cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid="atelier-source-checkbox"
                          checked={isChecked()}
                          aria-label={`Ground source ${displayTitle()}`}
                          onChange={() => toggleSourceSelection(sid)}
                          class="mt-0.5 shrink-0 accent-[var(--accent-cyan)] cursor-pointer"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-1 min-w-0">
                            <span class="text-[9.5px] font-mono-num text-[var(--accent-cyan)] shrink-0">
                              [S{idx() + 1}]
                            </span>
                            <span class="font-semibold truncate">{displayTitle()}</span>
                          </div>
                          <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] mt-0.5 truncate">
                            {String(s.source_kind || s.kind || 'document')} · {String(s.chunk_count ?? 1)} chunks
                          </div>
                        </div>
                      </label>
                      <div class="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          data-testid="atelier-preview-source-btn"
                          class="p-1 text-[var(--ink-muted)] hover:text-[var(--accent-cyan)] cursor-pointer"
                          title="Preview source in Universal 17-Format Viewer"
                          onClick={() => void handlePreviewSource(s)}
                        >
                          <Eye class="w-3 h-3" />
                        </button>
                        <Show when={sid}>
                          <button
                            type="button"
                            class="p-1 text-[var(--ink-muted)] hover:text-[var(--status-coral)] cursor-pointer"
                            title="Delete source"
                            onClick={() => void handleDeleteSource(sid)}
                          >
                            <Trash2 class="w-3 h-3" />
                          </button>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>

              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Source filename (e.g. notes.md)"
                  value={newSourceName()}
                  onInput={(e) => setNewSourceName(e.currentTarget.value)}
                  class="w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <textarea
                  rows={3}
                  placeholder="Paste source text (UTF-8)..."
                  value={newSourceText()}
                  onInput={(e) => setNewSourceText(e.currentTarget.value)}
                  class="w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] resize-none"
                />
                <button
                  type="button"
                  class="omnia-btn omnia-btn-primary w-full justify-center text-[11px]"
                  onClick={() => void handleIngest()}
                >
                  Ingest Source
                </button>
              </div>

              {/* Whisper Audio Transcribe */}
              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Audio path for Whisper transcribe..."
                  value={audioPath()}
                  onInput={(e) => setAudioPath(e.currentTarget.value)}
                  class="w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <button
                  type="button"
                  class="omnia-btn w-full justify-center text-[11px]"
                  onClick={() => void handleTranscribe()}
                >
                  <Mic class="w-3 h-3 text-[var(--accent-cyan)]" />
                  <span>Whisper Transcribe</span>
                </button>
              </div>

              {/* Public Gemini Share Import (Non-Bypassing) */}
              <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <input
                  type="text"
                  placeholder="Public Gemini share URL..."
                  value={shareUrl()}
                  onInput={(e) => setShareUrl(e.currentTarget.value)}
                  class="w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px]"
                />
                <button
                  type="button"
                  class="omnia-btn w-full justify-center text-[11px]"
                  onClick={() => void handleImportShare()}
                >
                  <Share2 class="w-3 h-3" />
                  <span>Import Public Share</span>
                </button>
                <Show when={shareGateState() === 'auth_required' || shareGateState() === 'captcha_blocked'}>
                  <div class="px-2 py-1 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[10.5px] font-mono-num text-[var(--accent-amber)]">
                    Gate: {shareGateState()} (non-bypass enforced)
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        {/* Grounded Q&A Column */}
        <div class="min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
          <div class="px-3.5 py-2 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[12px] min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-semibold text-[var(--ink-secondary)] truncate">Grounded Synthesis & Citations</span>
              <Show when={sources().length > 0}>
                <span class="omnia-badge font-mono-num text-[10px] text-[var(--accent-cyan)] shrink-0">
                  {groundedCountLabel()}
                </span>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-1 shrink-0">
              {(
                [
                  { eff: 'low', label: 'Nhanh' },
                  { eff: 'medium', label: 'Tư duy' },
                  { eff: 'high', label: 'Deep' },
                  { eff: 'max', label: 'Pro Max' },
                ] as const
              ).map((p) => (
                <button
                  type="button"
                  onClick={() => setEffort(p.eff)}
                  class="px-2 py-0.5 rounded border text-[11px] cursor-pointer"
                  classList={{
                    'bg-[var(--accent-dim)] border-[var(--accent-cyan)] text-[var(--accent-cyan)] font-semibold':
                      effort() === p.eff,
                    'border-[var(--border-subtle)] text-[var(--ink-muted)]': effort() !== p.eff,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div class="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3">
            <Show when={qaHistory().length === 0}>
              <div class="omnia-surface-panel rounded-lg p-4 text-[12px] text-[var(--ink-secondary)] space-y-1.5">
                <div class="font-semibold text-[var(--ink-primary)]">NotebookLM++ Grounded Workspace</div>
                <p class="text-[var(--ink-muted)] m-0">
                  Toggle per-source checkboxes on the left, ask grounded questions below, or generate any of the 11
                  interactive Studio artifacts (Mind Map SVG, Graded MCQ Quiz, Spaced-Repetition Flashcards, 2-Host
                  Podcast Player, FAQ, Timeline, and more).
                </p>
              </div>
            </Show>

            <For each={qaHistory()}>
              {(turn) => (
                <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 min-w-0">
                  <div class="flex items-start justify-between gap-2 min-w-0">
                    <div class="text-[12.5px] font-semibold text-[var(--accent-cyan)] min-w-0 break-words">
                      {maskText(turn.q, privacyMask())}
                    </div>
                    <Show when={typeof turn.groundedCount === 'number'}>
                      <span class="omnia-badge font-mono-num text-[10px] shrink-0">
                        {turn.groundedCount} src
                      </span>
                    </Show>
                  </div>
                  <div
                    class="omnia-prose text-[13px] min-w-0"
                    onClick={(e) =>
                      handleRichMarkdownClick(e, {
                        onCitationClick: (cid) => void jumpToCitation(cid),
                        onNotify: flashNotice,
                      })
                    }
                    innerHTML={renderRichMarkdown(
                      preprocessMarkdownCitations(maskText(turn.a, privacyMask()), turn.evidence),
                    )}
                  />
                  <Show when={turn.citations.length > 0}>
                    <div class="flex flex-wrap gap-1.5 pt-1">
                      <For each={turn.citations}>
                        {(cit, idx) => {
                          const ev = () =>
                            turn.evidence?.find(
                              (e) => e.marker === cit || e.marker.replace(/^\[|\]$/g, '') === cit.replace(/^\[|\]$/g, ''),
                            );
                          return (
                            <button
                              type="button"
                              data-testid="atelier-citation-badge"
                              class="omnia-badge text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                              title="Jump directly to cited source & highlighted excerpt"
                              onClick={() => void jumpToCitation(cit, ev()?.excerpt, ev())}
                            >
                              <Eye class="w-2.5 h-2.5 shrink-0" />
                              <span>
                                [{idx() + 1}] {cit.replace(/^\[|\]$/g, '').slice(0, 32)}
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                  <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)]">
                    <button
                      type="button"
                      class="omnia-btn text-[11px]"
                      onClick={() =>
                        openQuoteBtw({
                          text: turn.a.slice(0, 320),
                          sourceLabel: `Notebook ${activeNbId()}`,
                          surface: 'notebook',
                          notebookId: activeNbId(),
                        })
                      }
                    >
                      <MessageSquareQuote class="w-3 h-3 text-[var(--accent-amber)]" />
                      <span>Quote + BTW</span>
                    </button>
                    <span class="text-[11px] font-mono-num text-[var(--ink-muted)]">
                      {turn.citations.length} citations
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)] space-y-2 min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span class="text-[var(--ink-muted)] font-mono-num">Contextual Ask:</span>
              {(['explain', 'verify', 'summarize', 'code'] as const).map((preset) => (
                <button
                  type="button"
                  data-testid={`atelier-preset-${preset}`}
                  class="omnia-btn px-2 py-0.5 text-[11px] capitalize"
                  onClick={() => void handleAsk(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
            <div class="flex gap-2 min-w-0">
              <input
                ref={askInputRef}
                type="text"
                data-testid="atelier-ask-input"
                placeholder="Ask across selected grounded sources with inline citations..."
                value={askPrompt()}
                onInput={(e) => setAskPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAsk();
                }}
                class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-1.5 text-[13px] outline-none focus:border-[var(--border-accent)]"
              />
              <button
                type="button"
                data-testid="atelier-ask-submit"
                class="omnia-btn omnia-btn-primary text-[12px] shrink-0"
                onClick={() => void handleAsk()}
              >
                <Send class="w-3.5 h-3.5" />
                <span>Ask</span>
              </button>
            </div>
          </div>
        </div>

        {/* 11 Interactive Studio Artifacts Column */}
        <Show when={layoutMode() === 'ke_nhau'}>
          <div class="min-w-0 min-h-0 border-l border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-col overflow-hidden">
            <div class="p-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 min-w-0">
              <div class="flex items-center gap-1.5 text-[12px] font-semibold min-w-0">
                <Layers class="w-3.5 h-3.5 text-[var(--accent-amber)] shrink-0" />
                <span class="truncate">11 Studio Artifacts</span>
              </div>
              <button
                type="button"
                class="omnia-btn px-1.5 py-0.5 text-[10px] shrink-0"
                title={artifactExpanded() ? 'Restore column width' : 'Expand Artifact Studio panel'}
                onClick={() => setArtifactExpanded((v) => !v)}
              >
                <Show when={artifactExpanded()} fallback={<Maximize2 class="w-3 h-3" />}>
                  <Minimize2 class="w-3 h-3" />
                </Show>
              </button>
            </div>

            <div class="p-2.5 border-b border-[var(--border-subtle)] space-y-2">
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                <For each={ARTIFACT_KINDS}>
                  {(a) => (
                    <button
                      type="button"
                      data-testid={`atelier-gen-${a.kind}`}
                      onClick={() => void handleGenerateArtifact(a.kind, a.label)}
                      class="min-w-0 p-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-[var(--border-accent)] text-[10.5px] font-medium text-left cursor-pointer"
                    >
                      <Sparkles class="w-3 h-3 text-[var(--accent-amber)] mb-0.5" />
                      <div class="truncate">{a.label}</div>
                    </button>
                  )}
                </For>
              </div>
              <input
                type="text"
                placeholder="Optional focus prompt for artifact..."
                value={artifactFocusPrompt()}
                onInput={(e) => setArtifactFocusPrompt(e.currentTarget.value)}
                class="w-full min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
              />
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5">
              {/* Generated Artifacts List */}
              <Show when={artifacts().length > 0}>
                <div class="space-y-1.5 max-h-36 overflow-y-auto pr-0.5">
                  <For each={artifacts()}>
                    {(art) => (
                      <button
                        type="button"
                        onClick={() => selectArtifactRecord(art)}
                        class="w-full min-w-0 p-2 rounded border text-left text-[12px] cursor-pointer"
                        classList={{
                          'bg-[var(--bg-elevated)] border-[var(--border-accent)]': selectedArtifact() === art,
                          'bg-[var(--bg-panel)] border-[var(--border-subtle)]': selectedArtifact() !== art,
                        }}
                      >
                        <div class="flex items-center justify-between gap-1.5 min-w-0">
                          <span class="font-semibold truncate">{maskText(String(art.title || art.kind), privacyMask())}</span>
                          <CheckCircle2 class="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0" />
                        </div>
                        <div class="text-[10px] font-mono-num text-[var(--ink-muted)] truncate">
                          {normalizeArtifactKind(art.kind)}
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              {/* Selected Artifact Interactive Viewer */}
              <Show when={selectedArtifact()}>
                {(art) => (
                  <div class="omnia-surface-panel rounded p-3 space-y-2.5 text-[12px] min-w-0">
                    <div class="flex flex-wrap items-center justify-between gap-1.5 min-w-0 border-b border-[var(--border-subtle)] pb-2">
                      <div class="font-bold text-[var(--accent-cyan)] truncate min-w-0">
                        {maskText(String(art().title || art().kind), privacyMask())}
                      </div>
                      <span class="omnia-badge font-mono-num text-[10px] uppercase shrink-0">
                        {selectedArtifactKind()}
                      </span>
                    </div>

                    {/* 3. INTERACTIVE SVG PAN/ZOOM MIND MAP VIEWER */}
                    <Show when={selectedArtifactKind() === 'mind_map'}>
                      <div data-testid="atelier-mindmap-viewer" class="space-y-2 min-w-0">
                        <div class="flex flex-wrap items-center justify-between gap-1.5">
                          <div class="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              data-testid="atelier-mindmap-zoom-out"
                              class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                              title="Zoom Out"
                              onClick={() => setMindZoom((z) => Math.max(0.45, Number((z - 0.15).toFixed(2))))}
                            >
                              <ZoomOut class="w-3 h-3" />
                            </button>
                            <span class="font-mono-num text-[10.5px] px-1 text-[var(--ink-secondary)]">
                              {Math.round(mindZoom() * 100)}%
                            </span>
                            <button
                              type="button"
                              data-testid="atelier-mindmap-zoom-in"
                              class="omnia-btn px-1.5 py-0.5 text-[10.5px]"
                              title="Zoom In"
                              onClick={() => setMindZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))}
                            >
                              <ZoomIn class="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              data-testid="atelier-mindmap-reset"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              title="Reset Pan & Zoom"
                              onClick={() => {
                                setMindZoom(1);
                                setMindPan({ x: 0, y: 0 });
                                setCollapsedMindNodes([]);
                              }}
                            >
                              <RotateCcw class="w-3 h-3" />
                              <span>Reset</span>
                            </button>
                            <button
                              type="button"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              onClick={() => {
                                const tree = activeMindMapTree();
                                if (!tree) return;
                                if (collapsedMindNodes().length > 0) {
                                  setCollapsedMindNodes([]);
                                } else {
                                  setCollapsedMindNodes(collectBranchIds(tree).filter((id) => id !== tree.id));
                                }
                              }}
                            >
                              {collapsedMindNodes().length > 0 ? 'Expand' : 'Fold'}
                            </button>
                          </div>

                          <div class="omp-segmented text-[10px] shrink-0">
                            <button
                              type="button"
                              data-testid="atelier-mindmap-view-graph"
                              aria-pressed={mindMapViewMode() === 'graph'}
                              onClick={() => setMindMapViewMode('graph')}
                            >
                              <Network class="w-3 h-3 inline mr-1" />
                              SVG
                            </button>
                            <button
                              type="button"
                              data-testid="atelier-mindmap-view-raw"
                              aria-pressed={mindMapViewMode() === 'raw'}
                              onClick={() => setMindMapViewMode('raw')}
                            >
                              <Code2 class="w-3 h-3 inline mr-1" />
                              Raw
                            </button>
                          </div>
                        </div>

                        <Show when={mindMapViewMode() === 'graph' && mindMapLayout()}>
                          {(layout) => (
                            <div class="space-y-2 min-w-0">
                              <div
                                class="w-full h-[270px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden relative select-none"
                                classList={{
                                  'cursor-grabbing': isDraggingMind(),
                                  'cursor-grab': !isDraggingMind(),
                                }}
                                onPointerDown={(e) => {
                                  if ((e.target as HTMLElement).closest('[data-mind-interactive]')) return;
                                  setIsDraggingMind(true);
                                  dragOrigin = {
                                    px: mindPan().x,
                                    py: mindPan().y,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                  };
                                  (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                                }}
                                onPointerMove={(e) => {
                                  if (!isDraggingMind()) return;
                                  setMindPan({
                                    x: dragOrigin.px + (e.clientX - dragOrigin.startX),
                                    y: dragOrigin.py + (e.clientY - dragOrigin.startY),
                                  });
                                }}
                                onPointerUp={(e) => {
                                  if (!isDraggingMind()) return;
                                  setIsDraggingMind(false);
                                  try {
                                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                                  } catch {
                                    // ignore pointer capture release error
                                  }
                                }}
                                onWheel={(e) => {
                                  e.preventDefault();
                                  const delta = e.deltaY < 0 ? 0.1 : -0.1;
                                  setMindZoom((z) => Math.max(0.45, Math.min(2.2, Number((z + delta).toFixed(2)))));
                                }}
                              >
                                <svg
                                  width="100%"
                                  height="100%"
                                  viewBox={`0 0 ${layout().width} ${layout().height}`}
                                  preserveAspectRatio="xMinYMid meet"
                                >
                                  <g
                                    transform={`translate(${mindPan().x}, ${mindPan().y}) scale(${mindZoom()})`}
                                  >
                                    <For each={layout().edges}>
                                      {(edge) => {
                                        const mx = (edge.x1 + edge.x2) / 2;
                                        const activeEdge = () =>
                                          selectedMindNodeId() === edge.toId || selectedMindNodeId() === edge.fromId;
                                        return (
                                          <path
                                            d={`M ${edge.x1} ${edge.y1} C ${mx} ${edge.y1}, ${mx} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                                            fill="none"
                                            stroke={activeEdge() ? 'var(--accent-cyan)' : 'var(--border-strong)'}
                                            stroke-width={activeEdge() ? 2 : 1.4}
                                          />
                                        );
                                      }}
                                    </For>

                                    <For each={layout().nodes}>
                                      {(item) => {
                                        const isSel = () => selectedMindNodeId() === item.node.id;
                                        const maskedLabel = () => maskText(item.node.label, privacyMask());
                                        const rectFill = () =>
                                          item.depth === 0
                                            ? 'var(--bg-elevated)'
                                            : isSel()
                                              ? 'var(--accent-dim)'
                                              : 'var(--bg-panel)';
                                        const rectStroke = () =>
                                          isSel()
                                            ? 'var(--accent-cyan)'
                                            : item.depth === 0
                                              ? 'var(--accent-amber)'
                                              : 'var(--border-strong)';
                                        return (
                                          <g
                                            data-mind-interactive="true"
                                            data-testid="atelier-mindmap-node"
                                            class="cursor-pointer"
                                            onClick={() => setSelectedMindNodeId(item.node.id)}
                                          >
                                            <title>{maskedLabel()}</title>
                                            <rect
                                              x={item.x}
                                              y={item.y}
                                              width={item.w}
                                              height={item.h}
                                              rx={6}
                                              ry={6}
                                              fill={rectFill()}
                                              stroke={rectStroke()}
                                              stroke-width={isSel() ? 2 : 1.2}
                                            />
                                            <text
                                              x={item.x + 10}
                                              y={item.y + item.h / 2 + 4}
                                              font-size="11"
                                              font-weight={item.depth === 0 ? '700' : '500'}
                                              fill="var(--ink-primary)"
                                            >
                                              {truncateSvgLabel(maskedLabel(), item.hasChildren ? 18 : 22)}
                                            </text>
                                            <Show when={item.hasChildren}>
                                              <g
                                                data-mind-interactive="true"
                                                data-testid="atelier-mindmap-toggle"
                                                class="cursor-pointer"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  toggleMindCollapse(item.node.id);
                                                }}
                                              >
                                                <circle
                                                  cx={item.x + item.w - 12}
                                                  cy={item.y + item.h / 2}
                                                  r={9}
                                                  fill="var(--bg-interactive)"
                                                  stroke="var(--border-accent)"
                                                  stroke-width="1"
                                                />
                                                <text
                                                  x={item.x + item.w - 12}
                                                  y={item.y + item.h / 2 + 3.5}
                                                  text-anchor="middle"
                                                  font-size="9.5"
                                                  font-weight="700"
                                                  fill="var(--accent-cyan)"
                                                >
                                                  {item.isCollapsed ? `+${item.childCount}` : '−'}
                                                </text>
                                              </g>
                                            </Show>
                                          </g>
                                        );
                                      }}
                                    </For>
                                  </g>
                                </svg>
                                <div class="absolute bottom-1.5 right-2 text-[9.5px] font-mono-num text-[var(--ink-muted)] pointer-events-none">
                                  Drag to pan · Wheel to zoom
                                </div>
                              </div>

                              {/* Selected Mind Map Node Action Bar */}
                              <Show when={selectedMindNode()}>
                                {(node) => (
                                  <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-1.5 min-w-0">
                                    <div class="text-[11.5px] font-semibold text-[var(--ink-primary)] break-words">
                                      {maskText(node().label, privacyMask())}
                                    </div>
                                    <Show when={node().citations.length > 0}>
                                      <div class="flex flex-wrap gap-1">
                                        <For each={node().citations}>
                                          {(cid) => (
                                            <button
                                              type="button"
                                              class="omnia-badge text-[10px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                              onClick={() => void jumpToCitation(cid, node().label)}
                                            >
                                              {cid.replace(/^\[|\]$/g, '')}
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                    <div class="flex flex-wrap items-center gap-1.5">
                                      <button
                                        type="button"
                                        data-testid="atelier-mindmap-ask-node"
                                        class="omnia-btn omnia-btn-primary px-2 py-1 text-[10.5px]"
                                        onClick={() => populateAskForMindNode(node(), false)}
                                      >
                                        <MessageCircle class="w-3 h-3" />
                                        <span>Ask Omnia about this node</span>
                                      </button>
                                      <button
                                        type="button"
                                        class="omnia-btn px-2 py-1 text-[10.5px]"
                                        onClick={() => populateAskForMindNode(node(), true)}
                                      >
                                        <Send class="w-3 h-3" />
                                        <span>Send</span>
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </Show>
                            </div>
                          )}
                        </Show>

                        <Show when={mindMapViewMode() === 'raw'}>
                          <div
                            class="omnia-prose text-[11.5px] max-h-64 overflow-y-auto"
                            onClick={(e) =>
                              handleRichMarkdownClick(e, {
                                onCitationClick: (cid) => void jumpToCitation(cid),
                                onNotify: flashNotice,
                              })
                            }
                            innerHTML={renderRichMarkdown(
                              preprocessMarkdownCitations(
                                maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                              ),
                            )}
                          />
                        </Show>
                      </div>
                    </Show>

                    {/* 4. INTERACTIVE GRADED MCQ QUIZ ENGINE */}
                    <Show when={selectedArtifactKind() === 'quiz'}>
                      <div data-testid="atelier-quiz-engine" class="space-y-2.5 min-w-0">
                        <div class="flex flex-wrap items-center justify-between gap-1.5">
                          <div class="flex flex-wrap items-center gap-1.5">
                            <span
                              data-testid="atelier-quiz-score"
                              class="omnia-badge font-mono-num text-[11px] text-[var(--accent-cyan)]"
                            >
                              Score: {quizScore().correct} / {quizScore().total} · {quizScore().pct}%
                            </span>
                            <span class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                              {quizScore().answered}/{quizScore().total} answered
                            </span>
                          </div>
                          <div class="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              data-testid="atelier-quiz-retry"
                              class="omnia-btn px-2 py-0.5 text-[10.5px]"
                              onClick={() => setQuizAnswers({})}
                            >
                              <RotateCcw class="w-3 h-3" />
                              <span>Retry Quiz</span>
                            </button>
                            <button
                              type="button"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              onClick={() => setQuizViewMode((m) => (m === 'interactive' ? 'raw' : 'interactive'))}
                            >
                              {quizViewMode() === 'interactive' ? 'Raw' : 'Quiz'}
                            </button>
                          </div>
                        </div>

                        <Show when={quizViewMode() === 'interactive' && activeQuizQuestions().length > 0}>
                          <div class="w-full h-1.5 rounded bg-[var(--bg-canvas)] overflow-hidden border border-[var(--border-subtle)]">
                            <div
                              class="h-full bg-[var(--status-emerald)] transition-all"
                              style={{
                                width: `${quizScore().total > 0 ? Math.round((quizScore().answered / quizScore().total) * 100) : 0}%`,
                              }}
                            />
                          </div>

                          <div class="space-y-2.5 max-h-[420px] overflow-y-auto pr-0.5">
                            <For each={activeQuizQuestions()}>
                              {(q) => {
                                const chosen = () => quizAnswers()[q.id];
                                const isAnswered = () => typeof chosen() === 'number';
                                return (
                                  <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-2 min-w-0">
                                    <div class="text-[12px] font-semibold text-[var(--ink-primary)] break-words">
                                      <span class="font-mono-num text-[var(--accent-amber)] mr-1">Q{q.number}.</span>
                                      {maskText(q.question, privacyMask())}
                                    </div>

                                    <div class="space-y-1">
                                      <For each={q.options}>
                                        {(opt, optIdx) => {
                                          const letter = OPTION_LETTERS[optIdx()] ?? String(optIdx() + 1);
                                          const isChosen = () => chosen() === optIdx();
                                          const isCorrect = () => optIdx() === q.correctIndex;
                                          const showRight = () => isAnswered() && isCorrect();
                                          const showWrong = () => isAnswered() && isChosen() && !isCorrect();
                                          return (
                                            <button
                                              type="button"
                                              data-testid="atelier-quiz-option"
                                              onClick={() => setQuizAnswers({ ...quizAnswers(), [q.id]: optIdx() })}
                                              class="w-full min-w-0 px-2.5 py-1.5 rounded border text-left text-[11.5px] flex items-start justify-between gap-2 cursor-pointer transition-colors"
                                              classList={{
                                                'border-[var(--status-emerald)] bg-[var(--status-emerald-dim)] text-[var(--ink-primary)] font-semibold':
                                                  showRight(),
                                                'border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--ink-primary)]':
                                                  showWrong(),
                                                'border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-[var(--border-accent)] text-[var(--ink-secondary)]':
                                                  !showRight() && !showWrong(),
                                                'opacity-65': isAnswered() && !showRight() && !showWrong(),
                                              }}
                                            >
                                              <div class="flex items-start gap-2 min-w-0">
                                                <span class="font-mono-num font-bold text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-subtle)] shrink-0">
                                                  {letter}
                                                </span>
                                                <span class="break-words min-w-0">{maskText(opt, privacyMask())}</span>
                                              </div>
                                              <Show when={showRight()}>
                                                <Check class="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0 mt-0.5" />
                                              </Show>
                                              <Show when={showWrong()}>
                                                <X class="w-3.5 h-3.5 text-[var(--status-coral)] shrink-0 mt-0.5" />
                                              </Show>
                                            </button>
                                          );
                                        }}
                                      </For>
                                    </div>

                                    <Show when={isAnswered()}>
                                      <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] space-y-1.5 text-[11px]">
                                        <div
                                          class="font-semibold"
                                          classList={{
                                            'text-[var(--status-emerald)]': chosen() === q.correctIndex,
                                            'text-[var(--status-coral)]': chosen() !== q.correctIndex,
                                          }}
                                        >
                                          {chosen() === q.correctIndex
                                            ? 'Correct — grounded explanation:'
                                            : `Incorrect (Correct answer: ${OPTION_LETTERS[q.correctIndex] ?? q.correctIndex + 1}) — grounded explanation:`}
                                        </div>
                                        <div class="text-[var(--ink-secondary)] break-words">
                                          {maskText(q.explanation, privacyMask())}
                                        </div>
                                        <Show when={q.citations.length > 0}>
                                          <div class="flex flex-wrap gap-1 pt-0.5">
                                            <For each={q.citations}>
                                              {(cid) => (
                                                <button
                                                  type="button"
                                                  data-testid="atelier-quiz-citation"
                                                  class="omnia-badge text-[10px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                                  onClick={() => void jumpToCitation(cid, q.explanation)}
                                                >
                                                  <Eye class="w-2.5 h-2.5" />
                                                  <span>{cid.replace(/^\[|\]$/g, '')}</span>
                                                </button>
                                              )}
                                            </For>
                                          </div>
                                        </Show>
                                      </div>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </Show>

                        <Show when={quizViewMode() === 'raw' || activeQuizQuestions().length === 0}>
                          <div
                            class="omnia-prose text-[12px] max-h-64 overflow-y-auto"
                            onClick={(e) =>
                              handleRichMarkdownClick(e, {
                                onCitationClick: (cid) => void jumpToCitation(cid),
                                onNotify: flashNotice,
                              })
                            }
                            innerHTML={renderRichMarkdown(
                              preprocessMarkdownCitations(
                                maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                              ),
                            )}
                          />
                        </Show>
                      </div>
                    </Show>

                    {/* 5. SPACED-REPETITION INTERACTIVE FLASHCARDS */}
                    <Show when={selectedArtifactKind() === 'flashcards'}>
                      <div data-testid="atelier-flashcards-deck" class="space-y-2 min-w-0">
                        <div class="flex flex-wrap items-center justify-between gap-1.5 text-[10.5px] font-mono-num">
                          <div class="flex items-center gap-1">
                            <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={prevFlashcard}>
                              Prev
                            </button>
                            <span class="px-1 text-[var(--ink-secondary)]">
                              {orderedFlashcards().length > 0 ? Math.min(flashcardIdx() + 1, orderedFlashcards().length) : 0} /{' '}
                              {orderedFlashcards().length}
                            </span>
                            <button type="button" class="omnia-btn px-2 py-0.5 text-[10.5px]" onClick={nextFlashcard}>
                              Next
                            </button>
                          </div>

                          <div class="flex items-center gap-1.5">
                            <span
                              data-testid="atelier-flashcard-mastered"
                              class="omnia-badge text-[10px] text-[var(--status-emerald)]"
                            >
                              {masteredFlashcardCount()}/{orderedFlashcards().length} mastered
                            </span>
                            <button
                              type="button"
                              data-testid="atelier-flashcard-shuffle"
                              class="omnia-btn px-1.5 py-0.5 text-[10px]"
                              title="Shuffle deck"
                              onClick={handleShuffleFlashcards}
                            >
                              <Shuffle class="w-3 h-3" />
                              <span>Shuffle</span>
                            </button>
                          </div>
                        </div>

                        <Show when={currentFlashcard()}>
                          {(card) => {
                            const existingRating = () => flashcardRatings()[card().idx];
                            return (
                              <div class="space-y-2 min-w-0">
                                <button
                                  type="button"
                                  data-testid="atelier-flashcard-card"
                                  onClick={() => setFlashcardFlip((f) => !f)}
                                  class="w-full min-h-[124px] p-3.5 rounded-md border text-left cursor-pointer transition-all duration-150 flex flex-col justify-between gap-2"
                                  classList={{
                                    'border-[var(--accent-cyan)] bg-[var(--bg-elevated)]': flashcardFlip(),
                                    'border-[var(--border-strong)] bg-[var(--bg-canvas)]': !flashcardFlip(),
                                  }}
                                >
                                  <div class="flex items-center justify-between gap-2 text-[10px] font-mono-num uppercase">
                                    <span class={flashcardFlip() ? 'text-[var(--accent-cyan)]' : 'text-[var(--accent-amber)]'}>
                                      {flashcardFlip() ? 'Answer (Space / Click to Flip)' : 'Prompt (Space / Click to Flip)'}
                                    </span>
                                    <Show when={existingRating()}>
                                      <span class="omnia-badge text-[9.5px] uppercase">{existingRating()}</span>
                                    </Show>
                                  </div>
                                  <div class="text-[12.5px] text-[var(--ink-primary)] break-words leading-relaxed">
                                    {maskText(flashcardFlip() ? card().a : card().q, privacyMask())}
                                  </div>
                                  <Show when={card().hint && !flashcardFlip()}>
                                    <div class="pt-1">
                                      <Show
                                        when={showCardHint()}
                                        fallback={
                                          <span
                                            class="text-[10.5px] text-[var(--accent-cyan)] underline"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setShowCardHint(true);
                                            }}
                                          >
                                            Show hint
                                          </span>
                                        }
                                      >
                                        <span class="text-[11px] text-[var(--ink-muted)]">
                                          Hint: {maskText(card().hint!, privacyMask())}
                                        </span>
                                      </Show>
                                    </div>
                                  </Show>
                                </button>

                                <Show when={card().citations.length > 0}>
                                  <div class="flex flex-wrap gap-1">
                                    <For each={card().citations}>
                                      {(cid) => (
                                        <button
                                          type="button"
                                          class="omnia-badge text-[10px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                          onClick={() => void jumpToCitation(cid, card().a)}
                                        >
                                          <Eye class="w-2.5 h-2.5" />
                                          <span>{cid.replace(/^\[|\]$/g, '')}</span>
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </Show>

                                {/* Spaced-Repetition Mastery Rating Bar */}
                                <div class="grid grid-cols-4 gap-1.5">
                                  {(
                                    [
                                      { id: 'again', label: 'Again', key: '1', cls: 'text-[var(--status-coral)] border-[var(--status-coral)]' },
                                      { id: 'hard', label: 'Hard', key: '2', cls: 'text-[var(--accent-amber)] border-[var(--accent-amber)]' },
                                      { id: 'good', label: 'Good', key: '3', cls: 'text-[var(--accent-cyan)] border-[var(--accent-cyan)]' },
                                      { id: 'easy', label: 'Easy', key: '4', cls: 'text-[var(--status-emerald)] border-[var(--status-emerald)]' },
                                    ] as const
                                  ).map((btn) => (
                                    <button
                                      type="button"
                                      data-testid={`atelier-flashcard-rate-${btn.id}`}
                                      onClick={() => handleRateFlashcard(btn.id)}
                                      class={`min-w-0 px-1.5 py-1 rounded border text-[10.5px] font-semibold cursor-pointer bg-[var(--bg-elevated)] hover:bg-[var(--bg-interactive)] ${btn.cls}`}
                                      classList={{
                                        'ring-1 ring-[var(--border-accent)]': existingRating() === btn.id,
                                      }}
                                    >
                                      {btn.label}
                                    </button>
                                  ))}
                                </div>

                                <div class="text-[10px] font-mono-num text-[var(--ink-muted)] text-center">
                                  Space: Flip · ←/→: Navigate · 1-4: Rate
                                </div>
                              </div>
                            );
                          }}
                        </Show>
                      </div>
                    </Show>

                    {/* SLIDE DECK VIEWER */}
                    <Show when={selectedArtifactKind() === 'slide_deck'}>
                      <div class="space-y-1.5 min-w-0">
                        <div class="flex items-center justify-between text-[11px] font-mono-num">
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => setSlideIdx((i) => Math.max(0, i - 1))}
                          >
                            Prev
                          </button>
                          <span>
                            Slide {Math.min(slideIdx() + 1, activeSlides().length)} / {activeSlides().length}
                          </span>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5"
                            onClick={() => setSlideIdx((i) => Math.min(activeSlides().length - 1, i + 1))}
                          >
                            Next
                          </button>
                        </div>
                        <div
                          class="omnia-prose text-[12px] p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] min-w-0"
                          onClick={(e) =>
                            handleRichMarkdownClick(e, {
                              onCitationClick: (cid) => void jumpToCitation(cid),
                              onNotify: flashNotice,
                            })
                          }
                          innerHTML={renderRichMarkdown(
                            preprocessMarkdownCitations(maskText(activeSlides()[slideIdx()] ?? '', privacyMask())),
                          )}
                        />
                      </div>
                    </Show>

                    {/* 6. 2-HOST PODCAST AUDIO OVERVIEW PLAYER + INTERACTIVE "JOIN PODCAST" MODE */}
                    <Show when={selectedArtifactKind() === 'audio_overview'}>
                      <div data-testid="atelier-podcast-player" class="space-y-2.5 min-w-0">
                        {/* Playback Transport + Export Controls */}
                        <div class="flex flex-wrap items-center justify-between gap-1.5">
                          <div class="flex items-center gap-1">
                            <button
                              type="button"
                              data-testid="atelier-podcast-play"
                              class="omnia-btn omnia-btn-primary px-2.5 py-1 text-[11px]"
                              onClick={handlePodcastPlayPause}
                            >
                              <Show when={podcastState() === 'playing'} fallback={<Play class="w-3 h-3" />}>
                                <Pause class="w-3 h-3" />
                              </Show>
                              <span>{podcastState() === 'playing' ? 'Pause' : podcastState() === 'paused' ? 'Resume' : 'Play'}</span>
                            </button>
                            <button
                              type="button"
                              data-testid="atelier-podcast-stop"
                              class="omnia-btn px-2 py-1 text-[11px]"
                              title="Stop playback"
                              onClick={() => stopPodcastPlayback(true)}
                            >
                              <Square class="w-3 h-3" />
                              <span>Stop</span>
                            </button>
                          </div>

                          <div class="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              data-testid="atelier-podcast-export"
                              class="omnia-btn px-2 py-1 text-[10.5px]"
                              title="Export 2-Host Script (.md)"
                              onClick={handleExportPodcastScript}
                            >
                              <Download class="w-3 h-3" />
                              <span>.md</span>
                            </button>
                            <button
                              type="button"
                              class="omnia-btn px-1.5 py-1 text-[10px]"
                              onClick={() => setPodcastViewMode((m) => (m === 'player' ? 'raw' : 'player'))}
                            >
                              {podcastViewMode() === 'player' ? 'Raw' : 'Player'}
                            </button>
                          </div>
                        </div>

                        {/* Speed Bar (0.75x | 1x | 1.25x | 1.5x | 2x) */}
                        <div class="flex flex-wrap items-center justify-between gap-1 text-[10.5px] font-mono-num">
                          <span class="flex items-center gap-1 text-[var(--ink-muted)]">
                            <Headphones class="w-3 h-3 text-[var(--accent-cyan)]" />
                            <span>Speed</span>
                          </span>
                          <div class="flex flex-wrap gap-1">
                            <For each={PODCAST_SPEEDS}>
                              {(r) => (
                                <button
                                  type="button"
                                  data-testid="atelier-podcast-speed"
                                  class="omnia-btn px-1.5 py-0.5 text-[10px]"
                                  classList={{ 'border-[var(--accent-cyan)] text-[var(--accent-cyan)]': audioRate() === r }}
                                  onClick={() => handleSetAudioSpeed(r)}
                                >
                                  {r}x
                                </button>
                              )}
                            </For>
                          </div>
                        </div>

                        <Show when={!ttsSupported || ttsFallbackMode()}>
                          <div class="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] font-mono-num text-[var(--ink-muted)] flex items-center gap-1.5">
                            <Volume2 class="w-3 h-3 text-[var(--accent-amber)] shrink-0" />
                            <span>Teleprompter sync active (offline browser SpeechSynthesis unavailable)</span>
                          </div>
                        </Show>

                        {/* Preserve native <audio> element when WAV/audio URL exists */}
                        <Show when={art().audio_url || art().media_url}>
                          <audio
                            ref={audioElRef}
                            src={String(art().audio_url ?? art().media_url ?? '')}
                            controls
                            class="w-full"
                          />
                        </Show>

                        {/* 2-Host Dialogue Transcript (Click any turn to jump!) */}
                        <Show when={podcastViewMode() === 'player' && activePodcastTurns().length > 0}>
                          <div class="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
                            <For each={activePodcastTurns()}>
                              {(turn) => {
                                const isActive = () => activePodcastTurn() === turn.index;
                                return (
                                  <div
                                    data-testid="atelier-podcast-turn"
                                    onClick={() => {
                                      setActivePodcastTurn(turn.index);
                                      if (podcastState() === 'playing') {
                                        speakPodcastTurn(turn.index);
                                      }
                                    }}
                                    class="p-2 rounded border cursor-pointer transition-colors space-y-1 min-w-0"
                                    classList={{
                                      'border-[var(--accent-cyan)] bg-[var(--accent-dim)]':
                                        isActive() && turn.hostRole === 'A',
                                      'border-[var(--accent-amber)] bg-[var(--accent-amber-dim)]':
                                        isActive() && turn.hostRole === 'B',
                                      'border-[var(--border-subtle)] bg-[var(--bg-canvas)] hover:border-[var(--border-strong)]':
                                        !isActive(),
                                    }}
                                  >
                                    <div class="flex items-center justify-between gap-1.5 text-[10.5px] font-mono-num">
                                      <span
                                        class="font-bold"
                                        classList={{
                                          'text-[var(--accent-cyan)]': turn.hostRole === 'A',
                                          'text-[var(--accent-amber)]': turn.hostRole === 'B',
                                        }}
                                      >
                                        {turn.speaker}
                                      </span>
                                      <div class="flex items-center gap-1 shrink-0">
                                        <Show when={isActive() && podcastState() === 'playing'}>
                                          <span class="omnia-badge text-[9px] text-[var(--status-emerald)]">LIVE</span>
                                        </Show>
                                        <span class="text-[var(--ink-muted)]">#{turn.index + 1}</span>
                                      </div>
                                    </div>
                                    <div class="text-[11.5px] text-[var(--ink-primary)] leading-snug break-words">
                                      {maskText(turn.text, privacyMask())}
                                    </div>
                                    <Show when={turn.citations.length > 0}>
                                      <div class="flex flex-wrap gap-1 pt-0.5">
                                        <For each={turn.citations}>
                                          {(cid) => (
                                            <button
                                              type="button"
                                              class="omnia-badge text-[9.5px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                void jumpToCitation(cid, turn.text);
                                              }}
                                            >
                                              <Eye class="w-2.5 h-2.5" />
                                              <span>{cid.replace(/^\[|\]$/g, '')}</span>
                                            </button>
                                          )}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </div>

                          {/* Interactive "Join / Interrupt Podcast" Input */}
                          <div class="p-2 rounded border border-[var(--border-strong)] bg-[var(--bg-elevated)] space-y-1.5 min-w-0">
                            <div class="flex items-center justify-between gap-1 text-[10.5px]">
                              <span class="font-semibold text-[var(--accent-amber)] flex items-center gap-1">
                                <Mic class="w-3 h-3" />
                                <span>Join / Interrupt Podcast</span>
                              </span>
                              <span class="font-mono-num text-[10px] text-[var(--ink-muted)]">
                                @ Turn #{activePodcastTurn() + 1}
                              </span>
                            </div>
                            <div class="flex gap-1.5 min-w-0">
                              <input
                                type="text"
                                data-testid="atelier-podcast-join-input"
                                placeholder="Ask hosts about this turn..."
                                value={podcastJoinPrompt()}
                                onInput={(e) => setPodcastJoinPrompt(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void handleJoinPodcast();
                                }}
                                class="flex-1 min-w-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11.5px] outline-none focus:border-[var(--border-accent)]"
                              />
                              <button
                                type="button"
                                data-testid="atelier-podcast-join-btn"
                                disabled={podcastJoinBusy()}
                                class="omnia-btn omnia-btn-primary px-2 py-1 text-[11px] shrink-0"
                                onClick={() => void handleJoinPodcast()}
                              >
                                <Send class="w-3 h-3" />
                                <span>{podcastJoinBusy() ? '...' : 'Join'}</span>
                              </button>
                            </div>
                            <Show when={podcastJoinReply()}>
                              {(reply) => (
                                <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[11px] space-y-1">
                                  <div class="font-mono-num text-[10px] text-[var(--accent-cyan)]">
                                    Reply @ Turn #{reply().turnNum}: {maskText(reply().q, privacyMask())}
                                  </div>
                                  <div class="text-[var(--ink-secondary)] line-clamp-4 break-words">
                                    {maskText(reply().a, privacyMask())}
                                  </div>
                                </div>
                              )}
                            </Show>
                          </div>
                        </Show>

                        <Show when={podcastViewMode() === 'raw' || activePodcastTurns().length === 0}>
                          <div
                            class="omnia-prose text-[12px] max-h-56 overflow-y-auto"
                            onClick={(e) =>
                              handleRichMarkdownClick(e, {
                                onCitationClick: (cid) => void jumpToCitation(cid),
                                onNotify: flashNotice,
                              })
                            }
                            innerHTML={renderRichMarkdown(
                              preprocessMarkdownCitations(
                                maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                              ),
                            )}
                          />
                        </Show>
                      </div>
                    </Show>

                    {/* FAQ STRUCTURED VIEWER */}
                    <Show when={selectedArtifactKind() === 'faq'}>
                      <Show
                        when={activeFaqEntries().length > 0}
                        fallback={
                          <div
                            class="omnia-prose text-[12px] max-h-64 overflow-y-auto"
                            onClick={(e) =>
                              handleRichMarkdownClick(e, {
                                onCitationClick: (cid) => void jumpToCitation(cid),
                                onNotify: flashNotice,
                              })
                            }
                            innerHTML={renderRichMarkdown(
                              preprocessMarkdownCitations(
                                maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                              ),
                            )}
                          />
                        }
                      >
                        <div class="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                          <For each={activeFaqEntries()}>
                            {(entry) => {
                              const [open, setOpen] = createSignal(true);
                              return (
                                <div class="rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => setOpen((o) => !o)}
                                    class="w-full p-2 text-left flex items-start justify-between gap-2 text-[11.5px] font-semibold text-[var(--ink-primary)] cursor-pointer hover:bg-[var(--bg-elevated)]"
                                  >
                                    <span class="flex items-start gap-1.5 min-w-0">
                                      <HelpCircle class="w-3.5 h-3.5 text-[var(--accent-cyan)] shrink-0 mt-0.5" />
                                      <span class="break-words">{maskText(entry.question, privacyMask())}</span>
                                    </span>
                                    <Show when={open()} fallback={<ChevronRight class="w-3.5 h-3.5 shrink-0" />}>
                                      <ChevronDown class="w-3.5 h-3.5 shrink-0" />
                                    </Show>
                                  </button>
                                  <Show when={open()}>
                                    <div class="px-2.5 pb-2.5 pt-1 border-t border-[var(--border-subtle)] space-y-1.5 text-[11.5px] text-[var(--ink-secondary)]">
                                      <div class="break-words">{maskText(entry.answer, privacyMask())}</div>
                                      <Show when={entry.citations.length > 0}>
                                        <div class="flex flex-wrap gap-1">
                                          <For each={entry.citations}>
                                            {(cid) => (
                                              <button
                                                type="button"
                                                class="omnia-badge text-[10px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                                onClick={() => void jumpToCitation(cid, entry.answer)}
                                              >
                                                <Eye class="w-2.5 h-2.5" />
                                                <span>{cid.replace(/^\[|\]$/g, '')}</span>
                                              </button>
                                            )}
                                          </For>
                                        </div>
                                      </Show>
                                    </div>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </Show>

                    {/* TIMELINE STRUCTURED VIEWER */}
                    <Show when={selectedArtifactKind() === 'timeline'}>
                      <Show
                        when={activeTimelineEvents().length > 0}
                        fallback={
                          <div
                            class="omnia-prose text-[12px] max-h-64 overflow-y-auto"
                            onClick={(e) =>
                              handleRichMarkdownClick(e, {
                                onCitationClick: (cid) => void jumpToCitation(cid),
                                onNotify: flashNotice,
                              })
                            }
                            innerHTML={renderRichMarkdown(
                              preprocessMarkdownCitations(
                                maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                              ),
                            )}
                          />
                        }
                      >
                        <div class="space-y-2 max-h-72 overflow-y-auto pl-2 border-l-2 border-[var(--border-accent)]">
                          <For each={activeTimelineEvents()}>
                            {(ev) => (
                              <div class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] space-y-1 min-w-0">
                                <div class="flex items-center justify-between gap-1.5 text-[10.5px] font-mono-num">
                                  <span class="text-[var(--accent-amber)] flex items-center gap-1 font-semibold">
                                    <Clock class="w-3 h-3" />
                                    <span>{ev.label}</span>
                                  </span>
                                  <span class="text-[var(--ink-muted)]">#{ev.order}</span>
                                </div>
                                <div class="text-[12px] font-semibold text-[var(--ink-primary)] break-words">
                                  {maskText(ev.title, privacyMask())}
                                </div>
                                <div class="text-[11.5px] text-[var(--ink-secondary)] break-words">
                                  {maskText(ev.detail, privacyMask())}
                                </div>
                                <Show when={ev.citations.length > 0}>
                                  <div class="flex flex-wrap gap-1 pt-0.5">
                                    <For each={ev.citations}>
                                      {(cid) => (
                                        <button
                                          type="button"
                                          class="omnia-badge text-[10px] text-[var(--status-emerald)] cursor-pointer hover:border-[var(--border-accent)]"
                                          onClick={() => void jumpToCitation(cid, ev.detail)}
                                        >
                                          <Eye class="w-2.5 h-2.5" />
                                          <span>{cid.replace(/^\[|\]$/g, '')}</span>
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </Show>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>

                    {/* GENERIC RICH MARKDOWN ARTIFACTS (briefing, study_guide, data_table, infographic) */}
                    <Show
                      when={
                        selectedArtifactKind() !== 'flashcards' &&
                        selectedArtifactKind() !== 'slide_deck' &&
                        selectedArtifactKind() !== 'audio_overview' &&
                        selectedArtifactKind() !== 'mind_map' &&
                        selectedArtifactKind() !== 'quiz' &&
                        selectedArtifactKind() !== 'faq' &&
                        selectedArtifactKind() !== 'timeline'
                      }
                    >
                      <div
                        class="omnia-prose text-[12px] max-h-64 overflow-y-auto min-w-0"
                        onClick={(e) =>
                          handleRichMarkdownClick(e, {
                            onCitationClick: (cid) => void jumpToCitation(cid),
                            onNotify: flashNotice,
                          })
                        }
                        innerHTML={renderRichMarkdown(
                          preprocessMarkdownCitations(
                            maskText(String(art().content_markdown || art().body || JSON.stringify(art(), null, 2)), privacyMask()),
                          ),
                        )}
                      />
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
