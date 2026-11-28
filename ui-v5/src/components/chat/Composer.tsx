import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  BookMarked,
  Brain,
  Cpu,
  Database,
  Download,
  FilePlus2,
  GitBranch,
  Globe,
  ListOrdered,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  Send,
  Sigma,
  Slash,
  Sparkles,
  Square,
  Swords,
  X,
  Zap,
} from 'lucide-solid';
import { api } from '@/api/client';
import {
  abortActiveStream,
  activePersona,
  activePersonaId,
  activeSessionId,
  agentRunMode,
  attachments,
  composerCaret,
  composerDraft,
  enqueueAdditiveSteer,
  exportActiveSession,
  flashNotice,
  focusMode,
  handleSlashCommand,
  isStreaming,
  modelCatalog,
  modelConfig,
  modelPickerTriggerSeq,
  openWorkbench,
  pendingPasteChoice,
  ragScope,
  refreshResearchSources,
  researchMode,
  researchProgress,
  researchSources,
  selectStudioPersona,
  sendComposerMessage,
  setAgentRunMode,
  setAttachments,
  setComposerCaret,
  setComposerDraft,
  setFocusMode,
  setPendingPasteChoice,
  setRagScope,
  setResearchDrawerOpen,
  setResearchMode,
  setSteerDrawerOpen,
  setThinkMode,
  steerQueue,
  studioPersonas,
  thinkMode,
  updateDualModelConfig,
} from '@/state/studio';
import type { AgentRunMode, AttachmentItem, EffortLevel, FocusMode, RagScope, ResearchMode, ThinkMode } from '@/types';
import { detectEncryptedArchive, sha256Hex } from '@/utils/crypto';
import { LATEX_15_TEMPLATES } from '@/utils/markdown';

const SLASH_COMMANDS = [
  { cmd: '/arena', desc: 'Open AI Studio & Multi-Model Parallel Arena (Gems, Elo, Get Code)', immediate: true },
  { cmd: '/canvas', desc: 'Open Live Interactive Artifacts Canvas & Preview Drawer', immediate: true },
  { cmd: '/focus', desc: 'Switch focus mode: solo | web | academic | code | rag | deep', immediate: false },
  { cmd: '/persona', desc: 'Activate an Omnia Gem / Persona (or /persona clear)', immediate: false },
  { cmd: '/research', desc: 'Run Deep Research & open Sources Ledger (Web + Academic)', immediate: false },
  { cmd: '/sources', desc: 'Open Sources (Searched, Viewed & Extracted) Drawer', immediate: true },
  { cmd: '/rag', desc: 'Open Persistent Local+Global RAG & Knowledge Vault', immediate: true },
  { cmd: '/think', desc: 'Open Deep Think Falsification & Red-Team Lab', immediate: true },
  { cmd: '/goal', desc: 'Open Mission Lifecycle OS (Goal / Spec / Blueprint / Plan)', immediate: true },
  { cmd: '/todo', desc: 'Open Mission Lifecycle Todo & DoD Gate Matrix', immediate: true },
  { cmd: '/dod', desc: 'Inspect Definition of Done (DoD) acceptance gates', immediate: true },
  { cmd: '/handoff', desc: 'Write cross-session Mission Handoff receipt', immediate: true },
  { cmd: '/learn', desc: 'Capture Auto-Learn lesson or Crystallize to Skill', immediate: true },
  { cmd: '/skills', desc: 'Open 1,001-Skill Vault & Bilingual VN-EN DAG Composer', immediate: true },
  { cmd: '/rewind', desc: 'Preview atomic BLAKE3 checkpoint diff before rewinding', immediate: true },
  { cmd: '/fork', desc: 'Fork active SQLite session from current turn', immediate: true },
  { cmd: '/compact', desc: 'Trigger Lakeview anchored context compaction', immediate: true },
  { cmd: '/model', desc: 'Configure Main & Subagent model + 5-level effort', immediate: true },
  { cmd: '/btw', desc: 'Open interactive /btw side-thread drawer (or type btw: ...)', immediate: true },
  { cmd: '/steer', desc: 'Open Additive Steer Queue Drawer (token_budget: NULL)', immediate: true },
  { cmd: '/swarm', desc: 'Inspect active Peer-Mesh swarm & Graphify graph', immediate: true },
  { cmd: '/obs', desc: 'Open Lab-Grade AI Telemetry & Observatory', immediate: true },
  { cmd: '/speedtest', desc: 'Run on-demand Speedtest & Bufferbloat probe', immediate: true },
  { cmd: '/privacy', desc: 'Toggle Global Privacy Mask (P)', immediate: true },
  { cmd: '/export', desc: 'Export Observatory diagnostic JSON', immediate: true },
  { cmd: '/clear', desc: 'Clear current draft & attachment staging', immediate: true },
];

const FOCUS_PILLS: Array<{ id: FocusMode | 'arena'; label: string; title: string }> = [
  { id: 'solo', label: 'SOLO YOLO', title: 'Full-freedom SOLO YOLO agent mode (default)' },
  { id: 'web', label: 'Perplexity Web', title: 'Live web search + cited answer engine with related follow-ups' },
  { id: 'academic', label: 'Academic', title: 'arXiv / OpenAlex / PubMed academic synthesis' },
  { id: 'deep', label: 'Deep Research', title: 'Multi-step Deep Research + Local & Global RAG synthesis' },
  { id: 'code', label: 'Deep Think', title: 'High-effort multi-hypothesis engineering & falsification' },
  { id: 'arena', label: 'Arena', title: 'Open Multi-Model Parallel Arena & Parameter Lab' },
];

export function Composer() {
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let recognitionRef: { stop: () => void } | null = null;

  const [isComposing, setIsComposing] = createSignal(false);
  const [latexOpen, setLatexOpen] = createSignal(false);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [attachMode, setAttachMode] = createSignal<'tray' | 'inline'>('tray');
  const [listening, setListening] = createSignal(false);

  onCleanup(() => {
    try {
      recognitionRef?.stop();
    } catch {
      // ignore speech cleanup errors
    }
  });

  let lastModelTrigger = modelPickerTriggerSeq();
  createEffect(() => {
    const seq = modelPickerTriggerSeq();
    if (seq > lastModelTrigger) {
      lastModelTrigger = seq;
      setModelPickerOpen(true);
    }
  });

  const slashMatches = createMemo(() => {
    const val = composerDraft();
    if (!val.startsWith('/')) return [];
    const q = val.split(/\s+/)[0].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
  });

  const insertAtCaret = (snippet: string) => {
    const draft = composerDraft();
    const pos = textareaRef ? textareaRef.selectionStart : composerCaret();
    const next = draft.slice(0, pos) + snippet + draft.slice(pos);
    setComposerDraft(next);
    const nextPos = pos + snippet.length;
    setComposerCaret(nextPos);
    requestAnimationFrame(() => {
      if (textareaRef) {
        textareaRef.focus();
        textareaRef.setSelectionRange(nextPos, nextPos);
      }
    });
  };

  const attachBytes = async (
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    placement: 'inline' | 'tray',
  ) => {
    const sha256 = await sha256Hex(bytes);
    const encryptedUnresolved = detectEncryptedArchive(name, bytes);

    const existing = attachments.find((a) => a.sha256 === sha256);
    if (existing) {
      if (placement === 'inline') {
        insertAtCaret(` @[${existing.name}](sha256:${existing.sha256.slice(0, 12)}) `);
      }
      return;
    }

    const id = `att-${sha256.slice(0, 12)}`;
    const item: AttachmentItem = {
      id,
      name,
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      sha256,
      placement,
      encryptedUnresolved,
      status: encryptedUnresolved ? 'ENCRYPTED_UNRESOLVED' : 'ready',
    };
    setAttachments([...attachments, item]);

    if (placement === 'inline') {
      insertAtCaret(` @[${name}](sha256:${sha256.slice(0, 12)}) `);
    }

    let b64: string | undefined;
    if (!encryptedUnresolved && bytes.byteLength <= 1024 * 1024) {
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      b64 = btoa(binary);
    }
    void api.uploadAttachment({
      sessionId: activeSessionId(),
      name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sha256,
      placement,
      bytesBase64: b64,
      encryptedUnresolved,
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      await attachBytes(file.name, file.type, buf, attachMode());
    }
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            const buf = new Uint8Array(await f.arrayBuffer());
            await attachBytes(f.name || `paste-${Date.now()}.bin`, f.type, buf, attachMode());
            return;
          }
        }
      }
    }
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.length > 4096) {
      e.preventDefault();
      const bytes = new TextEncoder().encode(text);
      const digest = await sha256Hex(bytes);
      setPendingPasteChoice({
        text,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        name: `pasted-snippet-${digest.slice(0, 8)}.txt`,
      });
    }
  };

  const toggleVoiceDictation = () => {
    if (listening()) {
      try {
        recognitionRef?.stop();
      } catch {
        // ignore stop error
      }
      setListening(false);
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const SpeechRec = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => {
          lang: string;
          interimResults: boolean;
          continuous: boolean;
          onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
          onerror: (() => void) | null;
          onend: (() => void) | null;
          start: () => void;
          stop: () => void;
        })
      | undefined;
    if (!SpeechRec) {
      flashNotice('Offline voice dictation unavailable in this browser runtime');
      return;
    }
    try {
      const rec = new SpeechRec();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (ev) => {
        let heard = '';
        for (let i = 0; i < ev.results.length; i++) {
          heard += ev.results[i][0].transcript;
        }
        if (heard.trim()) insertAtCaret(`${heard.trim()} `);
      };
      rec.onerror = () => {
        setListening(false);
        flashNotice('Voice dictation paused (microphone permission or offline speech engine)');
      };
      rec.onend = () => setListening(false);
      recognitionRef = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
      flashNotice('Voice dictation could not start');
    }
  };

  const activeMainModel = createMemo(
    () => modelCatalog.find((m) => m.spec === modelConfig.mainModel) ?? modelCatalog[0],
  );
  const activeSubModel = createMemo(
    () => modelCatalog.find((m) => m.spec === modelConfig.subagentModel) ?? modelCatalog[0],
  );

  const isBtwPrefix = createMemo(() => /^btw:\s*/i.test(composerDraft().trim()));

  // Live Pre-Send Token & 6-Decimal USD Estimator
  const preSendEstimate = createMemo(() => {
    const textChars = composerDraft().length + (activePersona()?.systemPrompt.length ?? 0);
    const attTokens = attachments.reduce((acc, a) => acc + Math.ceil(a.sizeBytes / 4), 0);
    const inputTokens = Math.max(1, Math.ceil(textChars / 4) + attTokens);
    const spec = modelConfig.mainModel.toLowerCase();
    const ratePerMillion = spec.includes('opus')
      ? 15
      : spec.includes('flash')
        ? 0.35
        : spec.includes('gpt')
          ? 2.5
          : 3.0;
    const estUsd = (inputTokens / 1_000_000) * ratePerMillion;
    return { inputTokens, estUsd };
  });

  const cycleResearchMode = () => {
    const order: ResearchMode[] = ['auto', 'deep', 'off'];
    setResearchMode(order[(order.indexOf(researchMode()) + 1) % order.length]);
  };

  const cycleThinkMode = () => {
    const order: ThinkMode[] = ['auto', 'deep', 'off'];
    setThinkMode(order[(order.indexOf(thinkMode()) + 1) % order.length]);
  };

  const cycleRagScope = () => {
    const order: RagScope[] = ['local_global', 'local', 'off'];
    setRagScope(order[(order.indexOf(ragScope()) + 1) % order.length]);
  };

  const selectFocusPill = (id: FocusMode | 'arena') => {
    if (id === 'arena') {
      openWorkbench('arena');
      return;
    }
    setFocusMode(id);
    if (id === 'deep') setResearchMode('deep');
    if (id === 'code') setThinkMode('deep');
    if (id === 'solo') setAgentRunMode('solo');
  };

  return (
    <section
      data-testid="band-composer"
      class="shrink-0 px-4 pb-3 pt-2 max-w-4xl w-full mx-auto relative"
    >
      {/* Zero-Tab-Hunting Power Bar: Focus Pills, Gem Selector, Pre-Send Cost & Thread Export */}
      <div class="mb-2 flex flex-wrap items-center justify-between gap-1.5 text-[11px] min-w-0">
        <div data-testid="composer-focus-pills" class="flex flex-wrap items-center gap-1 min-w-0">
          <For each={FOCUS_PILLS}>
            {(pill) => {
              const active = () => pill.id !== 'arena' && focusMode() === pill.id;
              return (
                <button
                  type="button"
                  data-focus-pill={pill.id}
                  aria-pressed={active()}
                  title={pill.title}
                  onClick={() => selectFocusPill(pill.id)}
                  class="px-2 py-0.5 rounded border text-[10.5px] font-medium cursor-pointer flex items-center gap-1"
                  classList={{
                    'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-semibold': active(),
                    'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]': !active(),
                  }}
                >
                  <Show when={pill.id === 'arena'}>
                    <Swords class="w-3 h-3 text-[var(--accent-amber)]" />
                  </Show>
                  <span>{pill.label}</span>
                </button>
              );
            }}
          </For>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 shrink-0">
          {/* Omnia Gem / Persona Quick-Selector */}
          <div class="flex items-center gap-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1.5 py-0.5">
            <Sparkles class="w-3 h-3 text-[var(--accent-amber)] shrink-0" />
            <select
              aria-label="Omnia Gem Persona"
              data-testid="composer-persona-select"
              value={activePersonaId() ?? ''}
              onChange={(e) => selectStudioPersona(e.currentTarget.value || null)}
              class="bg-transparent text-[10.5px] text-[var(--ink-primary)] outline-none cursor-pointer max-w-[130px]"
            >
              <option value="" class="bg-[var(--bg-panel)]">Default Agent</option>
              <For each={studioPersonas}>
                {(p) => (
                  <option value={p.id} class="bg-[var(--bg-panel)]">
                    Gem: {p.name}
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Live Pre-Send Token & 6-Decimal USD Estimator */}
          <span
            data-testid="composer-pre-send-estimate"
            class="omnia-badge font-mono-num text-[10px] text-[var(--ink-secondary)]"
            title="Live pre-send input token & 6-decimal USD estimate"
          >
            ~{preSendEstimate().inputTokens} tok · ${preSendEstimate().estUsd.toFixed(6)}
          </span>

          {/* Export Thread MD / HTML / JSON */}
          <div class="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-1 py-0.5 text-[10px] font-mono-num">
            <Download class="w-3 h-3 text-[var(--status-emerald)] mr-0.5" />
            <button
              type="button"
              class="px-1 hover:text-[var(--accent-cyan)] cursor-pointer"
              title="Export thread as Markdown (honors Privacy Mask)"
              onClick={() => exportActiveSession('markdown')}
            >
              MD
            </button>
            <button
              type="button"
              class="px-1 hover:text-[var(--accent-cyan)] cursor-pointer"
              title="Export thread as standalone offline HTML"
              onClick={() => exportActiveSession('html')}
            >
              HTML
            </button>
            <button
              type="button"
              class="px-1 hover:text-[var(--accent-cyan)] cursor-pointer"
              title="Export thread as JSON"
              onClick={() => exportActiveSession('json')}
            >
              JSON
            </button>
          </div>
        </div>
      </div>

      {/* Live Deep Research Multi-Stage Progress Strip */}
      <Show when={researchProgress.active}>
        <button
          type="button"
          onClick={() => setResearchDrawerOpen(true)}
          class="w-full mb-2 px-3 py-1.5 rounded border border-[var(--accent-cyan)] bg-[var(--accent-dim)] flex items-center justify-between gap-2 text-[11.5px] cursor-pointer"
        >
          <span class="font-semibold text-[var(--accent-cyan)] flex items-center gap-1.5">
            <Globe class="w-3.5 h-3.5 animate-pulse" />
            <span>Deep Research: {researchProgress.stage}</span>
          </span>
          <span class="font-mono-num text-[var(--ink-secondary)] truncate">
            {researchProgress.detail || `${researchProgress.searchedCount} searched · ${researchProgress.extractedCount} extracted`}
          </span>
        </button>
      </Show>

      {/* Active btw: Side-Thread Indicator */}
      <Show when={isBtwPrefix()}>
        <div class="mb-2 px-3 py-1 rounded border border-[var(--accent-amber)] bg-[var(--accent-amber-dim)] text-[11.5px] font-mono-num text-[var(--accent-amber)] flex items-center justify-between">
          <span>btw: Quick Side-Thread Mode — Enter opens isolated /btw drawer without polluting main transcript</span>
          <span class="font-bold">BTW</span>
        </div>
      </Show>

      {/* Interactive Additive Steer / Queue Strip */}
      <Show when={steerQueue.length > 0}>
        <button
          type="button"
          onClick={() => setSteerDrawerOpen(true)}
          class="w-full mb-2 px-3 py-1.5 rounded border border-[var(--border-accent)] bg-[var(--accent-dim)] flex items-center justify-between text-[11.5px] cursor-pointer hover:brightness-110"
        >
          <span class="font-semibold text-[var(--accent-cyan)] flex items-center gap-1.5">
            <ListOrdered class="w-3.5 h-3.5" />
            <span>ADDITIVE_INTAKE Queue ({steerQueue.length}) — token_budget: NULL</span>
          </span>
          <span class="font-mono-num text-[var(--ink-secondary)] truncate max-w-md">
            Inspect Drawer · Next: {steerQueue[steerQueue.length - 1]?.prompt}
          </span>
        </button>
      </Show>

      {/* Large-Paste Esc-Zero-Mutation Chooser */}
      <Show when={pendingPasteChoice()}>
        {(choice) => (
          <div class="mb-2 p-2.5 rounded-md border border-[var(--accent-amber)] bg-[var(--bg-elevated)] flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <div>
              <span class="font-semibold text-[var(--accent-amber)]">Large Paste Detected</span>{' '}
              <span class="font-mono-num text-[var(--ink-secondary)]">
                ({choice().sizeBytes} B · sha256:{choice().sha256.slice(0, 10)})
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11px]"
                onClick={() => {
                  const text = choice().text;
                  setPendingPasteChoice(null);
                  insertAtCaret(text);
                }}
              >
                Insert Inline
              </button>
              <button
                type="button"
                class="omnia-btn text-[11px]"
                onClick={async () => {
                  const c = choice();
                  setPendingPasteChoice(null);
                  await attachBytes(c.name, 'text/plain', new TextEncoder().encode(c.text), 'tray');
                }}
              >
                Attach as Tray Card
              </button>
              <button
                type="button"
                class="omnia-btn text-[11px]"
                onClick={() => setPendingPasteChoice(null)}
              >
                Cancel (Esc)
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Slash Command Overlay (Executes Real Actions!) */}
      <Show when={slashMatches().length > 0}>
        <div class="mb-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)] overflow-hidden">
          <div class="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)] border-b border-[var(--border-subtle)]">
            Slash Commands (Click or Enter to Execute)
          </div>
          <div class="max-h-48 overflow-y-auto">
            <For each={slashMatches()}>
              {(item, i) => (
                <button
                  type="button"
                  class="w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] cursor-pointer"
                  classList={{
                    'bg-[var(--bg-interactive)] text-[var(--ink-primary)]': slashIndex() === i(),
                    'text-[var(--ink-secondary)]': slashIndex() !== i(),
                  }}
                  onMouseEnter={() => setSlashIndex(i())}
                  onClick={() => {
                    if (item.immediate) {
                      void handleSlashCommand(item.cmd);
                    } else {
                      setComposerDraft(`${item.cmd} `);
                      textareaRef?.focus();
                    }
                  }}
                >
                  <span class="font-mono-num font-bold text-[var(--accent-cyan)]">{item.cmd}</span>
                  <span class="text-[var(--ink-muted)] truncate ml-2">{item.desc}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* 15-Template KaTeX / Physics / Chemistry Palette */}
      <Show when={latexOpen()}>
        <div class="mb-2 p-2.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)]">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11.5px] font-semibold text-[var(--ink-primary)]">
              Scientific LaTeX Palette (15 Offline Templates)
            </span>
            <button type="button" class="omnia-btn px-1.5 py-0.5 text-[11px]" onClick={() => setLatexOpen(false)}>
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto">
            <For each={LATEX_15_TEMPLATES}>
              {(tpl) => (
                <button
                  type="button"
                  onClick={() => {
                    insertAtCaret(tpl.displayMode ? `$$${tpl.latex}$$ ` : `$${tpl.latex}$ `);
                    setLatexOpen(false);
                  }}
                  class="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:border-[var(--border-accent)] text-left cursor-pointer"
                >
                  <div class="flex items-center justify-between text-[10.5px] font-semibold">
                    <span class="text-[var(--ink-primary)] truncate">{tpl.title}</span>
                    <span class="text-[var(--accent-amber)]">{tpl.category}</span>
                  </div>
                  <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] truncate mt-0.5">
                    {tpl.preview}
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Dual-Scope Main vs Subagent Model & 5-Level Effort Popover */}
      <Show when={modelPickerOpen()}>
        <div class="mb-2 p-3 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-md)] grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
          <div class="space-y-1.5 min-w-0">
            <div class="font-semibold text-[var(--accent-cyan)] flex items-center gap-1.5">
              <Cpu class="w-3.5 h-3.5" />
              <span>Main Agent Model &amp; Effort</span>
            </div>
            <select
              value={modelConfig.mainModel}
              onChange={(e) => void updateDualModelConfig({ mainModel: e.currentTarget.value })}
              class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px] text-[var(--ink-primary)]"
            >
              <For each={modelCatalog}>
                {(m) => <option value={m.spec}>{m.name} ({m.provider})</option>}
              </For>
            </select>
            <div class="flex flex-wrap items-center gap-1">
              <For each={activeMainModel().efforts}>
                {(eff) => (
                  <button
                    type="button"
                    onClick={() => void updateDualModelConfig({ mainEffort: eff as EffortLevel })}
                    class="px-2 py-1 rounded text-[11px] font-mono-num border cursor-pointer"
                    classList={{
                      'bg-[var(--accent-dim)] border-[var(--accent-cyan)] text-[var(--accent-cyan)] font-bold':
                        modelConfig.mainEffort === eff,
                      'bg-[var(--bg-canvas)] border-[var(--border-subtle)] text-[var(--ink-muted)]':
                        modelConfig.mainEffort !== eff,
                    }}
                  >
                    {eff}
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="space-y-1.5 min-w-0">
            <div class="font-semibold text-[var(--accent-amber)] flex items-center justify-between gap-1.5">
              <span class="flex items-center gap-1.5">
                <GitBranch class="w-3.5 h-3.5" />
                <span>Subagent / Verifier Scope</span>
              </span>
              <button type="button" class="omnia-btn px-1.5 py-0.5 text-[10px]" onClick={() => setModelPickerOpen(false)}>
                <X class="w-3 h-3" />
              </button>
            </div>
            <select
              value={modelConfig.subagentModel}
              onChange={(e) => void updateDualModelConfig({ subagentModel: e.currentTarget.value })}
              class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 text-[12px] text-[var(--ink-primary)]"
            >
              <For each={modelCatalog}>
                {(m) => <option value={m.spec}>{m.name} ({m.provider})</option>}
              </For>
            </select>
            <div class="flex flex-wrap items-center gap-1">
              <For each={activeSubModel().efforts}>
                {(eff) => (
                  <button
                    type="button"
                    onClick={() => void updateDualModelConfig({ subagentEffort: eff as EffortLevel })}
                    class="px-2 py-1 rounded text-[11px] font-mono-num border cursor-pointer"
                    classList={{
                      'bg-[var(--accent-amber-dim)] border-[var(--accent-amber)] text-[var(--accent-amber)] font-bold':
                        modelConfig.subagentEffort === eff,
                      'bg-[var(--bg-canvas)] border-[var(--border-subtle)] text-[var(--ink-muted)]':
                        modelConfig.subagentEffort !== eff,
                    }}
                  >
                    {eff}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Main Band Composer Card */}
      <div class="omnia-surface-panel rounded-xl overflow-hidden border-[var(--border-strong)] focus-within:border-[var(--border-accent)]">
        {/* Tray Attachment Chips */}
        <Show when={attachments.length > 0}>
          <div class="px-3 pt-2.5 flex flex-wrap gap-1.5">
            <For each={attachments}>
              {(att) => (
                <div
                  class="flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-mono-num"
                  classList={{
                    'border-[var(--status-coral)] bg-[var(--status-coral-dim)] text-[var(--status-coral)]':
                      att.encryptedUnresolved,
                    'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--ink-secondary)]':
                      !att.encryptedUnresolved,
                  }}
                >
                  <span>{att.name}</span>
                  <span class="text-[var(--ink-muted)]">
                    {att.encryptedUnresolved ? 'ENCRYPTED_UNRESOLVED (0B)' : `${att.sizeBytes}B`}
                  </span>
                  <span class="text-[10px] text-[var(--accent-cyan)]">#{att.sha256.slice(0, 6)}</span>
                  <button
                    type="button"
                    class="hover:text-[var(--status-coral)] cursor-pointer"
                    onClick={() => setAttachments(attachments.filter((x) => x.id !== att.id))}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Vietnamese IME Safe Textarea */}
        <textarea
          ref={textareaRef}
          rows={3}
          value={composerDraft()}
          placeholder="Ask Omnia, type / for commands, @ for files, $...$ for KaTeX... (Enter to send, Shift+Enter newline)"
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onInput={(e) => {
            setComposerDraft(e.currentTarget.value);
            setComposerCaret(e.currentTarget.selectionStart);
          }}
          onSelect={(e) => setComposerCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (isComposing() || (e as KeyboardEvent).isComposing) return;
            if (e.key === 'Escape' && pendingPasteChoice()) {
              e.preventDefault();
              setPendingPasteChoice(null);
              return;
            }
            if (slashMatches().length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              const len = slashMatches().length;
              setSlashIndex((idx) => (e.key === 'ArrowDown' ? (idx + 1) % len : (idx - 1 + len) % len));
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (slashMatches().length > 0 && composerDraft().trim() === '/') {
                const chosen = slashMatches()[slashIndex()];
                if (chosen) void handleSlashCommand(chosen.cmd);
                return;
              }
              void sendComposerMessage();
            }
          }}
          class="w-full bg-transparent px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[var(--ink-primary)] placeholder-[var(--ink-muted)] resize-none outline-none"
        />

        {/* Composer Bottom Toolbar */}
        <div class="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-rail)] flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1.5 min-w-0">
            {/* Trae Chat / Builder / SOLO Progression (Default: SOLO = YOLO · Turbo · Full Access · Auto-Approve) */}
            <div
              class="inline-flex rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-0.5 text-[11px] font-semibold"
              title="Execution Mode — defaults to SOLO (YOLO · Turbo · Full Access · Auto-Approve)"
            >
              {(
                [
                  { id: 'chat', title: 'Chat (Conversational · Auto-Approve YOLO)' },
                  { id: 'builder', title: 'Builder (Guided Tools · Auto-Approve YOLO)' },
                  { id: 'solo', title: 'SOLO (YOLO · Turbo · Full Access · Auto-Approve)' },
                ] as Array<{ id: AgentRunMode; title: string }>
              ).map((m) => (
                <button
                  type="button"
                  data-run-mode={m.id}
                  aria-pressed={agentRunMode() === m.id}
                  title={m.title}
                  onClick={() => setAgentRunMode(m.id)}
                  class="px-2 py-0.5 rounded cursor-pointer uppercase"
                  classList={{
                    'bg-[var(--bg-elevated)] text-[var(--accent-cyan)]': agentRunMode() === m.id,
                    'text-[var(--ink-muted)] hover:text-[var(--ink-primary)]': agentRunMode() !== m.id,
                  }}
                >
                  {m.id}
                </button>
              ))}
            </div>

            {/* Dual-Scope Model & Effort Trigger */}
            <button
              type="button"
              data-testid="dual-model-trigger"
              onClick={() => setModelPickerOpen(!modelPickerOpen())}
              class="omnia-btn text-[11px]"
              title="Main & Subagent Model + 5-Level Effort"
            >
              <Cpu class="w-3.5 h-3.5 text-[var(--accent-cyan)]" />
              <span class="max-w-[140px] truncate">{activeMainModel().name}</span>
              <span class="font-mono-num text-[var(--accent-amber)] uppercase">{modelConfig.mainEffort}</span>
            </button>

            <button
              type="button"
              onClick={() => setLatexOpen(!latexOpen())}
              class="omnia-btn text-[11px]"
              title="15 Offline LaTeX Templates"
            >
              <Sigma class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
              <span class="hidden sm:inline">LaTeX</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setComposerDraft('/');
                textareaRef?.focus();
              }}
              class="omnia-btn text-[11px]"
              title="Slash Commands"
            >
              <Slash class="w-3.5 h-3.5" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              class="hidden"
              onChange={(e) => void handleFiles(e.currentTarget.files)}
            />
            <button
              type="button"
              class="omnia-btn text-[11px]"
              onClick={() => fileInputRef?.click()}
              title="Attach files (SHA-256 deduplicated)"
            >
              <Paperclip class="w-3.5 h-3.5" />
              <span class="hidden md:inline">{attachMode() === 'inline' ? 'Inline' : 'Tray'}</span>
            </button>
            <button
              type="button"
              class="omnia-btn px-1.5 py-1 text-[10px]"
              onClick={() => setAttachMode(attachMode() === 'tray' ? 'inline' : 'tray')}
              title="Toggle Attachment Mode (Tray vs Inline-at-Caret)"
            >
              {attachMode() === 'tray' ? <Plus class="w-3 h-3" /> : <FilePlus2 class="w-3 h-3" />}
            </button>

            {/* Voice Dictation (SpeechRecognition with graceful offline fallback) */}
            <button
              type="button"
              data-testid="composer-voice-btn"
              onClick={toggleVoiceDictation}
              class="omnia-btn px-2 py-1 text-[10.5px]"
              classList={{
                'border-[var(--status-coral)] text-[var(--status-coral)] bg-[var(--status-coral-dim)]': listening(),
              }}
              title="Voice Dictation (browser SpeechRecognition with offline fallback)"
            >
              {listening() ? <MicOff class="w-3.5 h-3.5" /> : <Mic class="w-3.5 h-3.5" />}
            </button>

            {/* Default-ON Adaptive Intelligence Toggles: Research, Deep Think, Persistent RAG & Sources */}
            <button
              type="button"
              data-testid="toggle-research-mode"
              onClick={cycleResearchMode}
              class="omnia-btn px-2 py-1 text-[10.5px] font-mono-num"
              classList={{
                'border-[var(--accent-cyan)] text-[var(--accent-cyan)] bg-[var(--accent-dim)]': researchMode() !== 'off',
              }}
              title="Default-ON Adaptive Deep Research (click to cycle: Auto -> Deep -> Off)"
            >
              <Globe class="w-3 h-3" />
              <span>Res:{researchMode() === 'auto' ? 'Auto' : researchMode() === 'deep' ? 'Deep' : 'Off'}</span>
            </button>

            <button
              type="button"
              data-testid="toggle-think-mode"
              onClick={cycleThinkMode}
              class="omnia-btn px-2 py-1 text-[10.5px] font-mono-num"
              classList={{
                'border-[var(--accent-amber)] text-[var(--accent-amber)] bg-[var(--accent-amber-dim)]': thinkMode() !== 'off',
              }}
              title="Default-ON Adaptive Deep Think (click to cycle: Auto -> Deep -> Off)"
            >
              <Brain class="w-3 h-3" />
              <span>Think:{thinkMode() === 'auto' ? 'Auto' : thinkMode() === 'deep' ? 'Deep' : 'Off'}</span>
            </button>

            <button
              type="button"
              data-testid="toggle-rag-scope"
              onClick={cycleRagScope}
              class="omnia-btn px-2 py-1 text-[10.5px] font-mono-num"
              classList={{
                'border-[var(--status-emerald)] text-[var(--status-emerald)]': ragScope() !== 'off',
              }}
              title="Default-ON Persistent RAG Scope (Local+Global -> Local -> Off)"
            >
              <Database class="w-3 h-3" />
              <span>RAG:{ragScope() === 'local_global' ? 'L+G' : ragScope() === 'local' ? 'Loc' : 'Off'}</span>
            </button>

            <button
              type="button"
              data-testid="composer-sources-btn"
              onClick={() => {
                setResearchDrawerOpen(true);
                void refreshResearchSources();
              }}
              class="omnia-btn px-2 py-1 text-[10.5px] font-mono-num"
              title="Open Sources (Searched, Viewed & Extracted) Drawer"
            >
              <BookMarked class="w-3 h-3 text-[var(--accent-cyan)]" />
              <span>Sources{researchSources.length > 0 ? ` (${researchSources.length})` : ''}</span>
            </button>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <Show when={composerDraft().trim().length > 0 && !isStreaming()}>
              <button
                type="button"
                class="omnia-btn text-[11.5px]"
                title="Enqueue as ADDITIVE_INTAKE without interrupting active goal"
                onClick={async () => {
                  const text = composerDraft().trim();
                  if (!text) return;
                  setComposerDraft('');
                  await enqueueAdditiveSteer(text, 'queue');
                  setSteerDrawerOpen(true);
                }}
              >
                <ListOrdered class="w-3.5 h-3.5 text-[var(--accent-amber)]" />
                <span class="hidden sm:inline">Queue</span>
              </button>
            </Show>
            <Show when={isStreaming()}>
              <button
                type="button"
                class="omnia-btn omnia-btn-danger text-[11.5px]"
                onClick={abortActiveStream}
              >
                <Square class="w-3.5 h-3.5" />
                <span>Stop</span>
              </button>
            </Show>
            <button
              type="button"
              data-testid="composer-send"
              class="omnia-btn omnia-btn-primary text-[12px]"
              onClick={() => void sendComposerMessage()}
            >
              {isStreaming() ? <Zap class="w-3.5 h-3.5" /> : <Send class="w-3.5 h-3.5" />}
              <span>{isStreaming() ? 'Steer' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
