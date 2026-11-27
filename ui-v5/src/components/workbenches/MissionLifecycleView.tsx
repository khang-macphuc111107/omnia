import { For, Show, createEffect, createMemo, createSignal, onMount } from 'solid-js';
import {
  BookMarked,
  Brain,
  CheckCircle2,
  CheckSquare,
  Compass,
  FileCheck2,
  GitBranch,
  GraduationCap,
  Link2,
  Plus,
  Radar,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-solid';
import { api } from '@/api/client';
import { activeSessionId, flashNotice, lifecycleRefreshSeq, privacyMask } from '@/state/studio';
import { renderRichMarkdown } from '@/utils/markdown';
import { maskJson, maskText } from '@/utils/privacy';

const ARTIFACT_KINDS = [
  'goal',
  'spec',
  'blueprint',
  'plan',
  'todo',
  'progress',
  'dod',
  'handoff',
  'checkpoint',
  'memory',
  'lesson',
  'skill',
] as const;

type LifecycleSubTab = 'artifacts' | 'todo_dod' | 'handoff' | 'learn' | 'think';

export function MissionLifecycleView() {
  const [subTab, setSubTab] = createSignal<LifecycleSubTab>('artifacts');
  const [kindFilter, setKindFilter] = createSignal<string>('all');
  const [artifacts, setArtifacts] = createSignal<Array<Record<string, unknown>>>([]);
  const [links, setLinks] = createSignal<Array<Record<string, unknown>>>([]);
  const [superState, setSuperState] = createSignal<Record<string, unknown> | null>(null);
  const [lessons, setLessons] = createSignal<Array<Record<string, unknown>>>([]);
  const [gapRadar, setGapRadar] = createSignal<Record<string, unknown> | null>(null);
  const [thinkSessions, setThinkSessions] = createSignal<Array<Record<string, unknown>>>([]);
  const [selectedArt, setSelectedArt] = createSignal<Record<string, unknown> | null>(null);
  const [verifyReport, setVerifyReport] = createSignal<Record<string, unknown> | null>(null);
  const [statusNote, setStatusNote] = createSignal('');

  // Artifact upsert form
  const [artKind, setArtKind] = createSignal<string>('goal');
  const [artTitle, setArtTitle] = createSignal('');
  const [artContent, setArtContent] = createSignal('');
  const [linkFrom, setLinkFrom] = createSignal('');
  const [linkTo, setLinkTo] = createSignal('');
  const [linkRel, setLinkRel] = createSignal('satisfies');

  // Handoff form
  const [handoffSummary, setHandoffSummary] = createSignal('');
  const [handoffNext, setHandoffNext] = createSignal('');
  const [handoffNotes, setHandoffNotes] = createSignal('');

  // Learn / Crystallize form
  const [lessonTitle, setLessonTitle] = createSignal('');
  const [lessonBody, setLessonBody] = createSignal('');
  const [lessonScope, setLessonScope] = createSignal<'project' | 'global'>('project');
  const [promoteSlug, setPromoteSlug] = createSignal('');
  const [promoteTrigger, setPromoteTrigger] = createSignal('Use when ');

  // Deep Think form
  const [thinkProblem, setThinkProblem] = createSignal('');
  const [branchLabel, setBranchLabel] = createSignal('Branch B (SOTA)');
  const [branchHyp, setBranchHyp] = createSignal('');
  const [activeThinkId, setActiveThinkId] = createSignal('');

  const loadAll = async () => {
    const [artRes, superRes, lesRes, gapRes, thinkRes] = await Promise.all([
      api.listLifecycleArtifacts(),
      api.getSuperWorkflowState(),
      api.listLearnLessons(),
      api.getLearnGapRadar(),
      api.listThinkSessions(),
    ]);
    if (artRes.ok) {
      const list = (artRes.data.artifacts ?? []) as Array<Record<string, unknown>>;
      setArtifacts(Array.isArray(list) ? list : []);
      const lnk = (artRes.data.links ?? []) as Array<Record<string, unknown>>;
      setLinks(Array.isArray(lnk) ? lnk : []);
      if (Array.isArray(list) && list.length > 0 && !selectedArt()) setSelectedArt(list[0]);
    }
    if (superRes.ok) setSuperState(superRes.data);
    if (lesRes.ok) {
      const list = (lesRes.data.lessons ?? []) as Array<Record<string, unknown>>;
      setLessons(Array.isArray(list) ? list : []);
    }
    if (gapRes.ok) setGapRadar(gapRes.data);
    if (thinkRes.ok) {
      const list = (thinkRes.data.sessions ?? []) as Array<Record<string, unknown>>;
      setThinkSessions(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length > 0 && !activeThinkId()) {
        setActiveThinkId(String(list[0].id ?? list[0].thinkId ?? ''));
      }
    }
  };

  onMount(() => {
    void loadAll();
  });

  createEffect(() => {
    lifecycleRefreshSeq();
    void loadAll();
  });

  const filteredArtifacts = createMemo(() => {
    const f = kindFilter();
    if (f === 'all') return artifacts();
    return artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === f);
  });

  const todoArtifacts = createMemo(() =>
    artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === 'todo'),
  );
  const dodArtifacts = createMemo(() =>
    artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === 'dod'),
  );

  const handleUpsertArtifact = async () => {
    if (!artTitle().trim()) return;
    const res = await api.upsertLifecycleArtifact({
      kind: artKind(),
      title: artTitle().trim(),
      content: artContent().trim() || `# ${artTitle().trim()}\n`,
      projectToDisk: true,
    });
    if (res.ok) {
      setArtTitle('');
      setArtContent('');
      setStatusNote(`Saved ${artKind()} artifact (SQLite WAL + atomic LF)`);
      await loadAll();
    } else {
      setStatusNote(`Upsert error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleLinkArtifacts = async () => {
    if (!linkFrom().trim() || !linkTo().trim()) return;
    const res = await api.linkLifecycleArtifacts(linkFrom().trim(), linkTo().trim(), linkRel());
    setStatusNote(res.ok ? `Linked ${linkFrom()} -[${linkRel()}]-> ${linkTo()}` : `Link error (${res.error.code})`);
    await loadAll();
  };

  const handleVerifySelected = async () => {
    const art = selectedArt();
    if (!art) return;
    const res = await api.verifyLifecycleArtifact(
      String(art.content ?? art.body ?? ''),
      `${String(art.kind ?? 'artifact')}.md`,
    );
    setVerifyReport(res.ok ? res.data : { error: res.error.code, message: res.error.message });
    setStatusNote(res.ok ? 'Deterministic artifact verification complete' : `Verify (${res.error.code})`);
  };

  const handleCaptureLesson = async () => {
    if (!lessonTitle().trim() || !lessonBody().trim()) return;
    const res = await api.captureLearnLesson({
      title: lessonTitle().trim(),
      lesson: lessonBody().trim(),
      scope: lessonScope(),
    });
    if (res.ok) {
      setLessonTitle('');
      setLessonBody('');
      setStatusNote(`Captured ${lessonScope()} lesson`);
      await loadAll();
    } else {
      setStatusNote(`Learn error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handlePromoteLesson = async (lessonId: string) => {
    const slug = promoteSlug().trim() || `omnia-lesson-${lessonId.slice(0, 8)}`;
    const trigger = promoteTrigger().trim().startsWith('Use when')
      ? promoteTrigger().trim()
      : `Use when ${promoteTrigger().trim() || 'applying this verified engineering pattern'}`;
    const res = await api.promoteLessonToSkill(lessonId, slug, trigger);
    setStatusNote(res.ok ? `Crystallized lesson -> skill "${slug}"` : `Promote error (${res.error.code}): ${res.error.message}`);
    flashNotice(res.ok ? `Crystallized skill ${slug}` : `Promote note: ${res.error.message}`);
    await loadAll();
  };

  const handleStartThink = async () => {
    if (!thinkProblem().trim()) return;
    const res = await api.startThinkSession(activeSessionId(), thinkProblem().trim(), 'max');
    if (res.ok) {
      setThinkProblem('');
      const tid = String((res.data.session as Record<string, unknown> | undefined)?.id ?? res.data.thinkId ?? '');
      if (tid) setActiveThinkId(tid);
      setStatusNote('Started multi-hypothesis Deep Think session');
      await loadAll();
    } else {
      setStatusNote(`Think error (${res.error.code}): ${res.error.message}`);
    }
  };

  const handleAddBranch = async () => {
    if (!activeThinkId() || !branchHyp().trim()) return;
    const res = await api.addThinkBranch(activeThinkId(), branchLabel().trim(), branchHyp().trim());
    if (res.ok) {
      setBranchHyp('');
      setStatusNote(`Added hypothesis branch "${branchLabel()}"`);
      await loadAll();
    } else {
      setStatusNote(`Branch error (${res.error.code}): ${res.error.message}`);
    }
  };

  return (
    <div data-testid="lifecycle-workbench" class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
      {/* Header Bar */}
      <div class="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)] flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <Compass class="w-4 h-4 text-[var(--accent-cyan)]" />
          <span class="font-bold text-[13.5px]">Mission Lifecycle OS (12 Artifacts · Learn · Deep Think)</span>
          <span class="omnia-badge font-mono-num text-[var(--status-emerald)]">
            {artifacts().length} artifacts · {links().length} links
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <div class="omp-segmented text-[11.5px]">
            {(
              [
                { id: 'artifacts', label: '12 Artifacts' },
                { id: 'todo_dod', label: 'Todo & DoD' },
                { id: 'handoff', label: 'Handoff & Super' },
                { id: 'learn', label: 'Learn & Lessons' },
                { id: 'think', label: 'Deep Think Lab' },
              ] as const
            ).map((t) => (
              <button type="button" aria-pressed={subTab() === t.id} onClick={() => setSubTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" class="omnia-btn text-[11px]" onClick={() => void loadAll()}>
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Sync</span>
          </button>
        </div>
      </div>

      <Show when={statusNote()}>
        <div class="px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--accent-dim)] text-[11.5px] font-mono-num text-[var(--accent-cyan)]">
          {maskText(statusNote(), privacyMask())}
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 1. 12-Artifact Cross-Linked Graph */}
        <Show when={subTab() === 'artifacts'}>
          <div class="flex flex-wrap gap-1.5 text-[11px] font-mono-num">
            <button
              type="button"
              onClick={() => setKindFilter('all')}
              class="px-2 py-0.5 rounded border cursor-pointer"
              classList={{
                'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-bold': kindFilter() === 'all',
                'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-muted)]': kindFilter() !== 'all',
              }}
            >
              all ({artifacts().length})
            </button>
            {ARTIFACT_KINDS.map((k) => {
              const cnt = () => artifacts().filter((a) => String(a.kind ?? '').toLowerCase() === k).length;
              return (
                <button
                  type="button"
                  onClick={() => setKindFilter(k)}
                  class="px-2 py-0.5 rounded border cursor-pointer uppercase"
                  classList={{
                    'border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent-cyan)] font-bold': kindFilter() === k,
                    'border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[var(--ink-muted)]': kindFilter() !== k,
                  }}
                >
                  {k} ({cnt()})
                </button>
              );
            })}
          </div>

          <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
            <div class="space-y-3 min-w-0">
              {/* Create / Update Artifact */}
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 text-[12px] min-w-0">
                <div class="font-bold text-[12.5px] flex items-center gap-1.5">
                  <BookMarked class="w-4 h-4 text-[var(--accent-amber)]" />
                  <span>Create / Update Cross-Linked Artifact (SQLite WAL + Atomic LF)</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)] gap-2">
                  <select
                    aria-label="Artifact Kind"
                    value={artKind()}
                    onChange={(e) => setArtKind(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5 uppercase font-mono-num text-[11.5px]"
                  >
                    {ARTIFACT_KINDS.map((k) => (
                      <option value={k}>{k}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Title (e.g. GOAL-01 Deep Research Default-ON)"
                    value={artTitle()}
                    onInput={(e) => setArtTitle(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                  />
                </div>
                <textarea
                  rows={3}
                  placeholder="Markdown content (supports [[wiki-links]], AC-1..N, and 6-state receipts)..."
                  value={artContent()}
                  onInput={(e) => setArtContent(e.currentTarget.value)}
                  class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11.5px]"
                />
                <div class="flex justify-end">
                  <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleUpsertArtifact()}>
                    <Plus class="w-3.5 h-3.5" />
                    <span>Save Artifact</span>
                  </button>
                </div>
              </div>

              {/* Artifacts Inventory */}
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2">
                <div class="font-bold text-[12.5px]">Artifacts ({filteredArtifacts().length})</div>
                <div class="space-y-1.5 max-h-80 overflow-y-auto">
                  <Show
                    when={filteredArtifacts().length > 0}
                    fallback={
                      <div class="p-3 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[11.5px] font-mono-num text-[var(--ink-muted)]">
                        No artifacts match this filter yet. Create a Goal, Spec, Blueprint, Plan, Todo, or DoD gate above.
                      </div>
                    }
                  >
                    <For each={filteredArtifacts()}>
                      {(art) => (
                        <button
                          type="button"
                          onClick={() => setSelectedArt(art)}
                          class="w-full p-2.5 rounded border text-left cursor-pointer flex items-center justify-between gap-2 text-[12px]"
                          classList={{
                            'bg-[var(--bg-elevated)] border-[var(--border-accent)]': selectedArt() === art,
                            'bg-[var(--bg-canvas)] border-[var(--border-subtle)]': selectedArt() !== art,
                          }}
                        >
                          <div class="min-w-0">
                            <div class="flex items-center gap-1.5">
                              <span class="omnia-badge uppercase font-mono-num text-[10px] text-[var(--accent-cyan)]">
                                {String(art.kind ?? 'artifact')}
                              </span>
                              <span class="font-semibold truncate">{maskText(String(art.title ?? art.id ?? 'Untitled'), privacyMask())}</span>
                            </div>
                            <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)] truncate mt-0.5">
                              id:{String(art.id ?? '')} · status:{String(art.status ?? 'active')}
                            </div>
                          </div>
                          <span class="omnia-badge text-[10px] shrink-0 text-[var(--status-emerald)]">
                            {String(art.receiptState ?? art.status ?? 'active')}
                          </span>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>

            {/* Right Inspector: Selected Artifact + Deterministic Verifier + Cross-Links */}
            <div class="space-y-3 min-w-0">
              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2.5 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-[12.5px] flex items-center gap-1.5">
                    <FileCheck2 class="w-4 h-4 text-[var(--status-emerald)]" />
                    <span>Artifact Preview &amp; Deterministic Gate</span>
                  </span>
                  <button type="button" class="omnia-btn text-[11px]" onClick={() => void handleVerifySelected()}>
                    <ShieldCheck class="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                    <span>Verify Artifact</span>
                  </button>
                </div>
                <Show
                  when={selectedArt()}
                  fallback={<div class="text-[11.5px] text-[var(--ink-muted)]">Select an artifact to inspect.</div>}
                >
                  {(art) => (
                    <div
                      class="omnia-prose p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] max-h-60 overflow-y-auto text-[12.5px]"
                      innerHTML={renderRichMarkdown(maskText(String(art().content ?? art().body ?? ''), privacyMask()))}
                    />
                  )}
                </Show>
                <Show when={verifyReport()}>
                  <pre class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[10.5px] font-mono-num max-h-36 overflow-auto">
                    {JSON.stringify(maskJson(verifyReport(), privacyMask()), null, 2)}
                  </pre>
                </Show>
              </div>

              <div class="omnia-surface-panel rounded-lg p-3.5 space-y-2 text-[11.5px] min-w-0 overflow-hidden">
                <div class="font-bold text-[12.5px] flex items-center gap-1.5">
                  <Link2 class="w-4 h-4 text-[var(--accent-cyan)]" />
                  <span>Bidirectional Artifact Links ({links().length})</span>
                </div>
                <div class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-1.5 items-center">
                  <input
                    type="text"
                    placeholder="from_id"
                    value={linkFrom()}
                    onInput={(e) => setLinkFrom(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <select
                    value={linkRel()}
                    onChange={(e) => setLinkRel(e.currentTarget.value)}
                    class="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-1.5 py-1 font-mono-num"
                  >
                    <option value="satisfies">satisfies</option>
                    <option value="blocks">blocks</option>
                    <option value="derived_from">derived_from</option>
                    <option value="supersedes">supersedes</option>
                    <option value="learned_from">learned_from</option>
                    <option value="cites">cites</option>
                  </select>
                  <input
                    type="text"
                    placeholder="to_id"
                    value={linkTo()}
                    onInput={(e) => setLinkTo(e.currentTarget.value)}
                    class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                  />
                  <button
                    type="button"
                    data-testid="lifecycle-link-btn"
                    class="omnia-btn shrink-0 px-2 py-1"
                    onClick={() => void handleLinkArtifacts()}
                  >
                    Link
                  </button>
                </div>
                <div class="space-y-1 max-h-36 overflow-y-auto font-mono-num text-[11px]">
                  <For each={links()}>
                    {(l) => (
                      <div class="px-2 py-1 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] flex justify-between gap-2">
                        <span class="text-[var(--accent-cyan)] truncate">{String(l.fromId ?? l.from_id)}</span>
                        <span class="text-[var(--accent-amber)]">[{String(l.relation)}]</span>
                        <span class="text-[var(--status-emerald)] truncate">{String(l.toId ?? l.to_id)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* 2. Interactive Todo Checklist & Receipt-Gated DoD Ledger */}
        <Show when={subTab() === 'todo_dod'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <CheckSquare class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Interactive Todo Checklist ({todoArtifacts().length})</span>
              </div>
              <div class="space-y-1.5">
                <Show
                  when={todoArtifacts().length > 0}
                  fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">Create a `todo` artifact in Tab 1 to manage live checklist items.</div>}
                >
                  <For each={todoArtifacts()}>
                    {(t) => {
                      const tid = String(t.id ?? '');
                      const st = String(t.status ?? 'pending');
                      return (
                        <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                          <span class="font-medium truncate">{String(t.title ?? tid)}</span>
                          <div class="flex gap-1 shrink-0">
                            {(['pending', 'in_progress', 'done'] as const).map((nextSt) => (
                              <button
                                type="button"
                                class="omnia-btn px-2 py-0.5 text-[10px]"
                                classList={{ 'border-[var(--border-accent)] text-[var(--accent-cyan)]': st === nextSt }}
                                onClick={async () => {
                                  const r = await api.updateLifecycleTodo(tid, nextSt);
                                  setStatusNote(r.ok ? `Todo ${tid} -> ${nextSt}` : `Todo (${r.error.code})`);
                                  await loadAll();
                                }}
                              >
                                {nextSt}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <CheckCircle2 class="w-4 h-4 text-[var(--status-emerald)]" />
                <span>Receipt-Gated Definition of Done (DoD) ({dodArtifacts().length})</span>
              </div>
              <div class="space-y-1.5">
                <Show
                  when={dodArtifacts().length > 0}
                  fallback={<div class="text-[11.5px] font-mono-num text-[var(--ink-muted)]">No DoD gates stored yet. Every Verified gate requires an execution receipt.</div>}
                >
                  <For each={dodArtifacts()}>
                    {(g) => {
                      const gid = String(g.id ?? '');
                      return (
                        <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-2 text-[12px]">
                          <div class="min-w-0">
                            <div class="font-semibold truncate">{String(g.title ?? gid)}</div>
                            <div class="text-[10.5px] font-mono-num text-[var(--ink-muted)]">
                              status: {String(g.status ?? 'pending')}
                            </div>
                          </div>
                          <button
                            type="button"
                            class="omnia-btn px-2 py-0.5 text-[10.5px]"
                            onClick={async () => {
                              const r = await api.updateLifecycleDod(gid, 'verified', `verified-ui-${Date.now()}`);
                              setStatusNote(r.ok ? `DoD gate ${gid} verified with receipt` : `DoD (${r.error.code})`);
                              await loadAll();
                            }}
                          >
                            Mark Verified
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        {/* 3. Handoff (AGENT_NOTES Preserved) & Super Workflow State */}
        <Show when={subTab() === 'handoff'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px]">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <GitBranch class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Atomic Handoff &amp; Checkpoint Writer (Preserves AGENT_NOTES)</span>
              </div>
              <textarea
                rows={3}
                placeholder="Completed verified summary..."
                value={handoffSummary()}
                onInput={(e) => setHandoffSummary(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <input
                type="text"
                placeholder="Next executable atomic action..."
                value={handoffNext()}
                onInput={(e) => setHandoffNext(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <textarea
                rows={2}
                placeholder="Optional AGENT_NOTES_START..END persistent notes..."
                value={handoffNotes()}
                onInput={(e) => setHandoffNotes(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 font-mono-num text-[11px]"
              />
              <button
                type="button"
                class="omnia-btn omnia-btn-primary text-[11.5px]"
                onClick={async () => {
                  const r = await api.writeLifecycleHandoff(
                    handoffSummary().trim() || 'Checkpoint updated',
                    handoffNext().trim() || 'Resume remaining open gates',
                    handoffNotes().trim() || undefined,
                  );
                  setStatusNote(r.ok ? 'Handoff checkpoint written atomically' : `Handoff (${r.error.code}): ${r.error.message}`);
                  await loadAll();
                }}
              >
                Write Atomic Handoff
              </button>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Sparkles class="w-4 h-4 text-[var(--accent-cyan)]" />
                <span>Super-Plan / Super-Run Wave &amp; 3-Strike State</span>
              </div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-72 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(maskJson(superState() ?? { state: 'ready', tokenBudget: null }, privacyMask()), null, 2)}
              </pre>
            </div>
          </div>
        </Show>

        {/* 4. 2-Tier Learn, Lessons & Crystallize -> Skill + Gap Radar */}
        <Show when={subTab() === 'learn'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px] min-w-0">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <GraduationCap class="w-4 h-4 text-[var(--status-emerald)]" />
                <span>2-Tier Auto-Learn &amp; Lessons ({lessons().length})</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_130px] gap-2">
                <input
                  type="text"
                  placeholder="Lesson title..."
                  value={lessonTitle()}
                  onInput={(e) => setLessonTitle(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                />
                <select
                  value={lessonScope()}
                  onChange={(e) => setLessonScope(e.currentTarget.value as 'project' | 'global')}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1.5"
                >
                  <option value="project">Project Tier-1</option>
                  <option value="global">Global Tier-2</option>
                </select>
              </div>
              <textarea
                rows={2}
                placeholder="Reusable verified pitfall, invariant, or workflow lesson..."
                value={lessonBody()}
                onInput={(e) => setLessonBody(e.currentTarget.value)}
                class="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
              />
              <button type="button" class="omnia-btn omnia-btn-primary text-[11.5px]" onClick={() => void handleCaptureLesson()}>
                Capture Lesson
              </button>

              <div class="pt-2 border-t border-[var(--border-subtle)] grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                <input
                  type="text"
                  placeholder="Target skill slug (e.g. win32-dpi-guard)"
                  value={promoteSlug()}
                  onInput={(e) => setPromoteSlug(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 font-mono-num"
                />
                <input
                  type="text"
                  placeholder="Use when ..."
                  value={promoteTrigger()}
                  onInput={(e) => setPromoteTrigger(e.currentTarget.value)}
                  class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1"
                />
              </div>

              <div class="space-y-1.5 max-h-60 overflow-y-auto">
                <For each={lessons()}>
                  {(l) => {
                    const lid = String(l.id ?? '');
                    return (
                      <div class="p-2.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <div class="font-semibold text-[var(--ink-primary)]">{String(l.title ?? lid)}</div>
                          <div class="text-[11px] text-[var(--ink-secondary)] line-clamp-2">{String(l.lesson ?? l.content ?? '')}</div>
                        </div>
                        <button
                          type="button"
                          class="omnia-btn px-2 py-0.5 text-[10.5px] shrink-0"
                          onClick={() => void handlePromoteLesson(lid)}
                        >
                          Crystallize -&gt; Skill
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Radar class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Skill Gap Radar &amp; Semantic Overlap Telemetry</span>
              </div>
              <pre class="p-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-code)] text-[11px] font-mono-num max-h-80 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(maskJson(gapRadar() ?? { gaps: [] }, privacyMask()), null, 2)}
              </pre>
            </div>
          </div>
        </Show>

        {/* 5. Deep Think Multi-Hypothesis Lab */}
        <Show when={subTab() === 'think'}>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div class="omnia-surface-panel rounded-lg p-4 space-y-2.5 text-[12px] min-w-0">
              <div class="font-bold text-[13px] flex items-center gap-2">
                <Brain class="w-4 h-4 text-[var(--accent-amber)]" />
                <span>Deep Think Deliberation Engine (Hypotheses · Falsification · Red-Team)</span>
              </div>
              <div class="flex gap-2 min-w-0">
                <input
                  type="text"
                  placeholder="Frame complex engineering or math problem..."
                  value={thinkProblem()}
                  onInput={(e) => setThinkProblem(e.currentTarget.value)}
                  class="flex-1 min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5"
                />
                <button type="button" class="omnia-btn omnia-btn-primary shrink-0 text-[11.5px]" onClick={() => void handleStartThink()}>
                  Start Think
                </button>
              </div>

              <Show when={activeThinkId()}>
                <div class="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 min-w-0">
                  <div class="text-[11px] font-mono-num text-[var(--accent-cyan)]">Active Think ID: {activeThinkId()}</div>
                  <div class="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_auto] gap-1.5 items-center">
                    <input
                      type="text"
                      value={branchLabel()}
                      onInput={(e) => setBranchLabel(e.currentTarget.value)}
                      class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
                    />
                    <input
                      type="text"
                      placeholder="Alternative hypothesis / contrarian design..."
                      value={branchHyp()}
                      onInput={(e) => setBranchHyp(e.currentTarget.value)}
                      class="min-w-0 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-2 py-1 text-[11px]"
                    />
                    <button type="button" class="omnia-btn shrink-0 px-2 py-1 text-[11px]" onClick={() => void handleAddBranch()}>
                      Add Branch
                    </button>
                  </div>
                </div>
              </Show>
            </div>

            <div class="omnia-surface-panel rounded-lg p-4 space-y-2">
              <div class="font-bold text-[13px]">Persisted Deep Think Sessions ({thinkSessions().length})</div>
              <div class="space-y-2 max-h-80 overflow-y-auto text-[11.5px] font-mono-num">
                <Show
                  when={thinkSessions().length > 0}
                  fallback={<div class="text-[var(--ink-muted)]">No Deep Think sessions recorded yet. Start one on the left or run a chat turn with Think: Auto/Deep.</div>}
                >
                  <For each={thinkSessions()}>
                    {(ts) => {
                      const tid = String(ts.id ?? ts.thinkId ?? '');
                      return (
                        <button
                          type="button"
                          onClick={() => setActiveThinkId(tid)}
                          class="w-full p-2.5 rounded border bg-[var(--bg-canvas)] text-left cursor-pointer space-y-1"
                          classList={{
                            'border-[var(--border-accent)]': activeThinkId() === tid,
                            'border-[var(--border-subtle)]': activeThinkId() !== tid,
                          }}
                        >
                          <div class="font-semibold text-[var(--ink-primary)]">{String(ts.problem ?? tid)}</div>
                          <div class="text-[10.5px] text-[var(--ink-muted)]">
                            stage:{String(ts.stage ?? 'active')} · branches:{Array.isArray(ts.branches) ? ts.branches.length : 0}
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
